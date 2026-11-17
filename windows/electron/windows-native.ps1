param([int]$IgnoreProcessId = 0, [switch]$ValidateOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    # Hook 回调和消息循环全部留在 C#，避免后台线程进入 PowerShell runspace。
    Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace RabbitBall {
    public static class WindowsNative {
        const uint WM_QUIT = 0x0012, WM_TIMER = 0x0113, WM_CONFIGURE = 0x8001, WM_CANCEL_CAPTURE = 0x8002, WM_BEGIN_SELECTION = 0x8003;
        const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
        const uint WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
        const uint WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208;
        const uint WM_XBUTTONDOWN = 0x020B, WM_XBUTTONUP = 0x020C;
        static readonly UIntPtr focusInputMarker = new UIntPtr(0x52424641u);
        sealed class ShortcutMember { public string code; public int key; public bool modifier; }
        sealed class ShortcutBindings {
            public ShortcutMember[] prompt = new ShortcutMember[0];
            public ShortcutMember[] graph;
        }
        sealed class NativeConfig {
            public string requestId;
            public bool pauseOnFullscreen = true;
            public bool inputEnabled;
            public bool allowOwnForeground;
            public bool recording;
            public ShortcutBindings shortcuts = new ShortcutBindings();
        }
        sealed class Decision { public bool Suppress, Begin, Hold, End, Cancel, Waiting, StopTimer, SelectionDown, SelectionUp; public string Target; }
        sealed class SelectionRequest { public string Id, Target; }
        sealed class HeldKey { public KeyboardHook Raw; public bool Suppress, Eligible, Seeded; }

        // 只记专用键及已吞下的 Escape；每次按压的吞/透传决定保持到释放。
        sealed class TriggerState {
            readonly Dictionary<int, HeldKey> held = new Dictionary<int, HeldKey>();
            NativeConfig config = new NativeConfig();
            bool active, consumedLeftDown, holdEmitted, manualSelection;
            string activeTarget, pendingTarget;
            long startedAt;
            public NativeConfig Config { get { return config; } }
            public bool SuppressedModifierDown {
                get {
                    foreach (KeyValuePair<int, HeldKey> entry in held)
                        if (entry.Value.Suppress && ModifierKey(entry.Key)) return true;
                    return false;
                }
            }
            bool Armed { get { return config.inputEnabled && !config.recording; } }
            static bool Contains(ShortcutMember[] members, int id) {
                if (members != null) foreach (ShortcutMember member in members) if (member.key == id) return true;
                return false;
            }
            bool Member(int id) { return Contains(config.shortcuts.prompt, id) || Contains(config.shortcuts.graph, id); }
            ShortcutMember[] Binding(string target) { return target == "graph" ? config.shortcuts.graph : config.shortcuts.prompt; }
            bool ActiveMember(int id) { return Contains(Binding(activeTarget), id); }
            IEnumerable<ShortcutMember> Members() {
                foreach (ShortcutMember member in config.shortcuts.prompt) yield return member;
                if (config.shortcuts.graph != null) foreach (ShortcutMember member in config.shortcuts.graph) yield return member;
            }
            bool AltGrPrefix(int id) { return id == 0x21D && Member(0x138); }
            bool Complete(ShortcutMember[] members) {
                if (members == null || members.Length == 0) return false;
                foreach (ShortcutMember member in members) {
                    HeldKey key;
                    if (!held.TryGetValue(member.key, out key) || !key.Eligible) return false;
                }
                return true;
            }
            string CompleteTarget() {
                bool prompt = Complete(config.shortcuts.prompt), graph = Complete(config.shortcuts.graph);
                if (graph && (!prompt || config.shortcuts.graph.Length >= config.shortcuts.prompt.Length)) return "graph";
                return prompt ? "prompt" : null;
            }
            bool HasLongerBinding(string target) {
                ShortcutMember[] current = Binding(target), other = Binding(target == "graph" ? "prompt" : "graph");
                if (other == null || other.Length <= current.Length) return false;
                foreach (ShortcutMember member in current) if (!Contains(other, member.key)) return false;
                return true;
            }
            void Begin(string target, long now, Decision decision) {
                active = true;
                pendingTarget = null;
                activeTarget = decision.Target = target;
                holdEmitted = false;
                startedAt = now;
                decision.Begin = true;
            }
            void EndCycle() {
                active = false;
                manualSelection = false;
                holdEmitted = false;
                activeTarget = null;
                pendingTarget = null;
                // 组合完成或取消后须松开其成员，不能靠另一个成员的重复按下重入。
                foreach (HeldKey key in held.Values) key.Eligible = false;
            }
            void Cancel(Decision decision) {
                decision.Cancel = active;
                decision.Target = activeTarget;
                decision.StopTimer = pendingTarget != null;
                EndCycle();
            }
            static bool SameKeys(ShortcutMember[] left, ShortcutMember[] right) {
                if (left == null || right == null) return left == right;
                if (left.Length != right.Length) return false;
                foreach (ShortcutMember member in left) if (!Contains(right, member.key)) return false;
                return true;
            }
            static bool SameConfig(NativeConfig left, NativeConfig right) {
                if (left.inputEnabled != right.inputEnabled || left.recording != right.recording ||
                    left.pauseOnFullscreen != right.pauseOnFullscreen) return false;
                return SameKeys(left.shortcuts.prompt, right.shortcuts.prompt) && SameKeys(left.shortcuts.graph, right.shortcuts.graph);
            }
            public Decision Apply(NativeConfig next, Func<uint, bool> isDown = null) {
                Decision decision = new Decision();
                bool changed = !SameConfig(config, next);
                if (changed) Cancel(decision);
                config = next;
                // 旧配置只保留仍待释放的吞键；透传键不会阻塞新配置。
                List<int> obsolete = null;
                foreach (KeyValuePair<int, HeldKey> entry in held) {
                    if (entry.Value.Suppress || Member(entry.Key) || AltGrPrefix(entry.Key)) continue;
                    if (obsolete == null) obsolete = new List<int>();
                    obsolete.Add(entry.Key);
                }
                if (obsolete != null) foreach (int id in obsolete) held.Remove(id);
                if (changed && isDown != null) {
                    // 只采样新配置成员，启动或改键时已按住的键须先透传释放。
                    foreach (ShortcutMember member in Members()) {
                        if (held.ContainsKey(member.key)) continue;
                        uint scan = (uint)(member.key & 0xFF) | ((member.key & 0x100) != 0 ? 0xE000u : 0u);
                        uint vk = MapVirtualKey(scan, 3);
                        if (vk != 0 && isDown(vk)) held.Add(member.key, new HeldKey {
                            Raw = new KeyboardHook { Key = vk, Scan = scan & 0xFF, Flags = (member.key & 0x100) != 0 ? 1u : 0u },
                            Seeded = true
                        });
                    }
                }
                return decision;
            }
            public void ReleaseSeededKeys(Func<uint, bool> isDown) {
                List<int> released = null;
                foreach (KeyValuePair<int, HeldKey> entry in held) {
                    if (!entry.Value.Seeded || isDown(StartupVirtualKey(entry.Value.Raw))) continue;
                    if (released == null) released = new List<int>();
                    released.Add(entry.Key);
                }
                if (released != null) foreach (int id in released) held.Remove(id);
            }
            void RemoveSeededAliases(KeyboardHook raw) {
                List<int> aliases = null;
                foreach (KeyValuePair<int, HeldKey> entry in held) {
                    if (!entry.Value.Seeded || StartupVirtualKey(entry.Value.Raw) != StartupVirtualKey(raw)) continue;
                    if (aliases == null) aliases = new List<int>();
                    aliases.Add(entry.Key);
                }
                if (aliases != null) foreach (int id in aliases) held.Remove(id);
            }
            public Decision Key(KeyboardHook raw, bool down, long now, Func<bool> gate) {
                int id = KeyId(raw);
                Decision decision = pendingTarget != null ? Hold(now) : new Decision { Target = activeTarget };
                HeldKey existing;
                if (!down) {
                    if (held.TryGetValue(id, out existing)) {
                        decision.Suppress = existing.Suppress;
                        if (pendingTarget != null && Contains(Binding(pendingTarget), id)) Begin(pendingTarget, startedAt, decision);
                        if (active && !manualSelection && ActiveMember(id)) {
                            decision.Hold |= Hold(now).Hold;
                            decision.End = true;
                            EndCycle();
                        }
                        held.Remove(id);
                    }
                    RemoveSeededAliases(raw);
                    return decision;
                }
                if (held.TryGetValue(id, out existing)) {
                    decision.Suppress = existing.Suppress;
                    return decision;
                }
                if ((active || pendingTarget != null) && id == 1 && (manualSelection || !Contains(Binding(activeTarget ?? pendingTarget), id))) {
                    // 捕获中的 Escape 整次吞下，避免泄漏为系统 Alt+Esc。
                    Cancel(decision);
                    held.Add(id, new HeldKey { Raw = raw, Suppress = true });
                    decision.Suppress = true;
                    return decision;
                }
                bool prefix = AltGrPrefix(id);
                if (!Member(id) && !prefix) return decision;
                bool consume = Armed && gate();
                // 右 Alt 的模拟 Ctrl 若已经透传，本次 AltGr 也保持透传直到释放。
                HeldKey fakeControl;
                if (id == 0x138 && held.TryGetValue(0x21D, out fakeControl) && !fakeControl.Suppress) consume = false;
                held.Add(id, new HeldKey { Raw = raw, Suppress = consume, Eligible = consume && !prefix });
                decision.Suppress = consume;
                string target = !active ? CompleteTarget() : null;
                if (target != null) {
                    // 严格前缀先等更长组合；松键或长按成立后锁定本轮目标。
                    if (HasLongerBinding(target)) {
                        if (pendingTarget == null) {
                            pendingTarget = target;
                            startedAt = now;
                            decision.Waiting = true;
                        }
                    } else Begin(target, now, decision);
                }
                return decision;
            }
            public Decision Mouse(int button, bool down, long now) {
                Decision decision = new Decision { Target = activeTarget };
                if (button == 1 && !down && consumedLeftDown) {
                    consumedLeftDown = false;
                    decision.Suppress = true;
                    decision.SelectionUp = active;
                    if (active && manualSelection) {
                        decision.End = true;
                        EndCycle();
                    }
                } else if (button == 1 && down && (active || pendingTarget != null)) {
                    decision = Hold(now);
                    if (holdEmitted) {
                        consumedLeftDown = true;
                        decision.Suppress = decision.SelectionDown = true;
                    }
                }
                return decision;
            }
            public bool BeginSelection(string target) {
                if (!Armed || active || pendingTarget != null || consumedLeftDown) return false;
                // 相机按钮直接进入单次框选，沿用长按的鼠标账本，不合成启动键事件。
                active = manualSelection = holdEmitted = true;
                activeTarget = target;
                return true;
            }
            public Decision Hold(long now) {
                Decision decision = new Decision { Target = activeTarget };
                if (pendingTarget != null && now - startedAt >= 500) Begin(pendingTarget, startedAt, decision);
                if (active && !holdEmitted && now - startedAt >= 500) {
                    holdEmitted = true;
                    decision.Hold = true;
                }
                return decision;
            }
            public Decision CancelCapture() { Decision decision = new Decision(); Cancel(decision); return decision; }
        }
        [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public uint Size; public Rect Monitor, Work; public uint Flags; }
        [StructLayout(LayoutKind.Sequential)] struct KeyboardHook { public uint Key, Scan, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct MouseHook { public Point Point; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct HardwareInput { public uint Message; public ushort Low, High; }
        [StructLayout(LayoutKind.Explicit)] struct InputData {
            [FieldOffset(0)] public KeyboardInput Keyboard;
            [FieldOffset(0)] public MouseInput Mouse;
            [FieldOffset(0)] public HardwareInput Hardware;
        }
        [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputData Data; }
        [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Point; public uint Private; }
        delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);

        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int kind, HookProc callback, IntPtr module, uint thread);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] static extern uint MapVirtualKey(uint key, uint kind);
        [DllImport("user32.dll", SetLastError = true)] static extern int GetMessage(out Message message, IntPtr window, uint first, uint last);
        [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint first, uint last, uint remove);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
        [DllImport("user32.dll", SetLastError = true)] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint interval, IntPtr callback);
        [DllImport("user32.dll")] static extern bool KillTimer(IntPtr window, UIntPtr id);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
        [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern uint GetWindowStyle(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern uint SetWindowStyle(IntPtr window, int index, uint style);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

        static TriggerState state;
        static IntPtr keyboardHook, mouseHook;
        static HookProc keyboardCallback, mouseCallback;
        static readonly ConcurrentQueue<NativeConfig> pendingConfigurations = new ConcurrentQueue<NativeConfig>();
        static readonly ConcurrentQueue<SelectionRequest> pendingSelections = new ConcurrentQueue<SelectionRequest>();
        static uint hookThread;
        static int ignoreProcessId, captureId;
        static readonly Stopwatch clock = Stopwatch.StartNew();
        static UIntPtr holdTimer;
        static int holdCaptureId;
        static bool? previousFullscreen;
        static volatile string failure;
        static volatile string activeFocusRequest;
        static volatile bool suppressedModifierDown;
        static BlockingCollection<string> output;

        static void Emit(string json) { output.Add(json); }

        static void StopHoldTimer() {
            if (holdTimer != UIntPtr.Zero) {
                KillTimer(IntPtr.Zero, holdTimer);
                holdTimer = UIntPtr.Zero;
            }
        }

        static void EmitTrigger(Decision decision) {
            if (decision.StopTimer) StopHoldTimer();
            // 候选也占用新编号，避免上一轮迟到的取消清掉尚未开始的新组合。
            if (decision.Begin || decision.Waiting) captureId++;
            if (decision.Begin || decision.Waiting) {
                StopHoldTimer();
                holdCaptureId = captureId;
                holdTimer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 500, IntPtr.Zero);
                if (holdTimer == UIntPtr.Zero) {
                    failure = "无法启动长按检测。";
                    PostThreadMessage(hookThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
                }
            }
            if (decision.Begin) Emit("{\"type\":\"trigger-begin\",\"captureId\":" + captureId + ",\"target\":\"" + decision.Target + "\"}");
            if (decision.Hold) {
                StopHoldTimer();
                Emit("{\"type\":\"trigger-hold\",\"captureId\":" + captureId + ",\"target\":\"" + decision.Target + "\"}");
            }
            if (decision.End) { StopHoldTimer(); Emit("{\"type\":\"trigger-end\",\"captureId\":" + captureId + ",\"target\":\"" + decision.Target + "\"}"); }
            if (decision.Cancel) { StopHoldTimer(); Emit("{\"type\":\"trigger-cancel\",\"captureId\":" + captureId + ",\"target\":\"" + decision.Target + "\"}"); }
        }

        static bool ShouldCancel(int requested, int current) { return requested > 0 && requested == current; }

        static bool ValidRequestId(string requestId) {
            return !String.IsNullOrWhiteSpace(requestId) && requestId.Length <= 128;
        }

        static bool TryHandle(string text, out long handle) {
            return Int64.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out handle) && handle > 0 &&
                (IntPtr.Size == 8 || handle <= Int32.MaxValue);
        }

        static bool OwnsVisibleTarget(int expectedProcess, uint actualProcess, bool exists, bool visible) {
            return expectedProcess > 0 && actualProcess == (uint)expectedProcess && exists && visible;
        }

        static bool CurrentFocusRequest(string requestId) {
            return String.Equals(activeFocusRequest, requestId, StringComparison.Ordinal);
        }

        static string FocusResultJson(string requestId, bool focused) {
            return new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                { "type", "focus-result" }, { "requestId", requestId }, { "focused", focused }
            });
        }

        static void EmitFocusResult(string requestId, bool focused) {
            string json = FocusResultJson(requestId, focused && CurrentFocusRequest(requestId));
            // EOF 可能与工作线程完成同时发生，已关闭的输出队列无需再写入结果。
            try { output.Add(json); }
            catch (InvalidOperationException) { }
        }

        static bool PrepareOverlayWindow(long handle) {
            IntPtr target = new IntPtr(handle);
            uint owner;
            if (ignoreProcessId <= 0 || !IsWindow(target) || GetWindowThreadProcessId(target, out owner) == 0 || owner != (uint)ignoreProcessId) return false;
            // 悬浮工具窗的透明边界不能作为其它 Chromium 窗口的整矩形遮挡。
            uint style = GetWindowStyle(target, -20);
            SetWindowStyle(target, -20, style | 0x00000080);
            return IsWindow(target) && GetWindowThreadProcessId(target, out owner) != 0 && owner == (uint)ignoreProcessId && GetWindowStyle(target, -20) == (style | 0x00000080);
        }

        static bool CurrentFocusTarget(string requestId, IntPtr target) {
            if (!CurrentFocusRequest(requestId)) return false;
            uint owner;
            return GetWindowThreadProcessId(target, out owner) != 0 &&
                OwnsVisibleTarget(ignoreProcessId, owner, IsWindow(target), IsWindowVisible(target));
        }

        static bool ModifierKey(int key) {
            return key == 0x2A || key == 0x36 || key == 0x1D || key == 0x11D || key == 0x21D ||
                key == 0x38 || key == 0x138 || key == 0x15B || key == 0x15C;
        }

        static bool ModifiersDown(bool suppressed, Func<uint, bool> isDown) {
            return suppressed || isDown(0x10) || isDown(0x11) || isDown(0x12) || isDown(0x5B) || isDown(0x5C);
        }

        static bool FocusInput(KeyboardHook key) {
            return (key.Flags & 0x10) != 0 && key.Extra == focusInputMarker;
        }

        static Input[] FocusAltInputs() {
            return new Input[] {
                new Input { Type = 1, Data = new InputData { Keyboard = new KeyboardInput { Key = 0xA4, Extra = focusInputMarker } } },
                new Input { Type = 1, Data = new InputData { Keyboard = new KeyboardInput { Key = 0xA4, Flags = 2, Extra = focusInputMarker } } }
            };
        }

        static bool RetryForegroundWithAlt(Func<bool> currentTarget, Func<bool> modifiersDown, Func<Input[], uint> send, Action activate) {
            if (modifiersDown() || !currentTarget()) return false;
            Input[] inputs = FocusAltInputs();
            uint sent = send(inputs);
            // 若只送入按下，取消也必须配对释放；清理不会继续抢前台。
            if (sent == 1) send(new Input[] { inputs[1] });
            if (sent == 2 && currentTarget()) activate();
            return true;
        }

        static bool FocusOwnedWindow(string requestId, long handle) {
            IntPtr target = new IntPtr(handle);
            if (!CurrentFocusTarget(requestId, target)) return false;
            if (GetForegroundWindow() == target) return true;
            bool accepted = SetForegroundWindow(target), retried = false;
            // 跨线程激活异步完成，只短暂观察结果；绝不合并外部应用的输入队列。
            // 系统拒绝激活时保留可点击窗口，不用同步焦点调用强抢前台。
            for (int attempt = 0; attempt < 15; attempt++) {
                if (!CurrentFocusTarget(requestId, target)) return false;
                if (GetForegroundWindow() == target) return true;
                // 仅在本次观察期间等待修饰键松开，再补一次成对 Alt；不关联外部输入队列。
                if (!accepted && !retried) retried = RetryForegroundWithAlt(
                    delegate { return CurrentFocusTarget(requestId, target); },
                    delegate { return ModifiersDown(suppressedModifierDown, KeyIsDown); },
                    delegate(Input[] inputs) { return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))); },
                    delegate { SetForegroundWindow(target); });
                Thread.Sleep(10);
            }
            return CurrentFocusRequest(requestId) && GetForegroundWindow() == target;
        }

        static void FocusWorker(string requestId, long handle) {
            bool focused = false;
            try { focused = FocusOwnedWindow(requestId, handle); }
            catch { }
            EmitFocusResult(requestId, focused);
        }

        static int KeyId(KeyboardHook key) {
            // 部分系统注入事件只给 VK；补回物理身份，左右键与扩展键仍独立匹配。
            if ((key.Scan & 0xFF) == 0) {
                uint scan = MapVirtualKey(StartupVirtualKey(key), 4);
                return (int)(scan & 0xFF) | (((scan & 0xFF00) == 0xE000 || (key.Flags & 1) != 0) ? 0x100 : 0);
            }
            // 0x200 是系统模拟扫描码标记，AltGr 的 fake Ctrl 必须保持独立身份。
            return (int)(key.Scan & 0xFF) | ((key.Flags & 1) != 0 ? 0x100 : 0) | ((key.Scan & 0x200) != 0 ? 0x200 : 0);
        }

        static uint StartupVirtualKey(KeyboardHook key) {
            if (key.Key == 0x10) return (key.Scan & 0xFF) == 0x36 ? 0xA1u : 0xA0u;
            if (key.Key == 0x11) return (key.Flags & 1) != 0 ? 0xA3u : 0xA2u;
            if (key.Key == 0x12) return (key.Flags & 1) != 0 ? 0xA5u : 0xA4u;
            return key.Key;
        }

        static bool CanStartTrigger() {
            IntPtr foreground = GetForegroundWindow();
            uint foregroundOwner;
            GetWindowThreadProcessId(foreground, out foregroundOwner);
            if (ignoreProcessId > 0 && foregroundOwner == (uint)ignoreProcessId)
                return state.Config.allowOwnForeground;
            if (state.Config.pauseOnFullscreen && ReadFullscreen(foreground) == true) return false;
            return true;
        }

        static bool KeyIsDown(uint key) { return GetAsyncKeyState((int)key) < 0; }

        static IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
            if (code < 0) return CallNextHookEx(keyboardHook, code, message, data);
            KeyboardHook key = (KeyboardHook)Marshal.PtrToStructure(data, typeof(KeyboardHook));
            // 只放行自己的前台解锁输入；其它注入仍按原快捷键规则处理。
            if (FocusInput(key)) return CallNextHookEx(keyboardHook, code, message, data);
            uint kind = unchecked((uint)message.ToInt64());
            if (kind != WM_KEYDOWN && kind != WM_SYSKEYDOWN && kind != WM_KEYUP && kind != WM_SYSKEYUP)
                return CallNextHookEx(keyboardHook, code, message, data);
            bool down = kind == WM_KEYDOWN || kind == WM_SYSKEYDOWN;
            // 仅启动快照可用系统状态纠偏，运行期 held 仍严格由 hook 的 down/up 配对。
            state.ReleaseSeededKeys(KeyIsDown);
            Decision decision = state.Key(key, down, clock.ElapsedMilliseconds, CanStartTrigger);
            // 被吞修饰键未必反映到系统键态，工作线程只读此快照，不并发访问 held。
            suppressedModifierDown = state.SuppressedModifierDown;
            EmitTrigger(decision);
            return decision.Suppress ? new IntPtr(1) : CallNextHookEx(keyboardHook, code, message, data);
        }

        static IntPtr Mouse(int code, IntPtr message, IntPtr data) {
            if (code < 0) return CallNextHookEx(mouseHook, code, message, data);
            MouseHook mouse = (MouseHook)Marshal.PtrToStructure(data, typeof(MouseHook));
            uint kind = unchecked((uint)message.ToInt64());
            int button = 0;
            bool down = false;
            if (kind == WM_LBUTTONDOWN || kind == WM_LBUTTONUP) { button = 1; down = kind == WM_LBUTTONDOWN; }
            else if (kind == WM_RBUTTONDOWN || kind == WM_RBUTTONUP) { button = 2; down = kind == WM_RBUTTONDOWN; }
            else if (kind == WM_MBUTTONDOWN || kind == WM_MBUTTONUP) { button = 3; down = kind == WM_MBUTTONDOWN; }
            else if (kind == WM_XBUTTONDOWN || kind == WM_XBUTTONUP) { button = 3 + (int)(mouse.Data >> 16); down = kind == WM_XBUTTONDOWN; }
            Decision decision = state.Mouse(button, down, clock.ElapsedMilliseconds);
            EmitMouseDecision(decision, mouse.Point, down, button);
            return decision.Suppress ? new IntPtr(1) : CallNextHookEx(mouseHook, code, message, data);
        }

        static void EmitMouseDecision(Decision decision, Point point, bool down, int button = 1) {
            // 单次框选必须先提交最后的区域，再通知主进程结束捕获。
            if (!decision.End) EmitTrigger(decision);
            if (decision.SelectionDown || decision.SelectionUp) {
                string phase = decision.SelectionDown ? "down" : "up";
                Emit("{\"type\":\"selection-pointer\",\"captureId\":" + captureId + ",\"phase\":\"" + phase + "\",\"x\":" + point.X + ",\"y\":" + point.Y + "}");
            } else if (button != 0 && !decision.Suppress) Emit("{\"type\":\"pointer-" + (down ? "down" : "up") + "\",\"x\":" + point.X + ",\"y\":" + point.Y + "}");
            if (decision.End) EmitTrigger(decision);
        }

        static bool? ReadFullscreen(IntPtr window) {
            // 原生桌面同样铺满显示器；按句柄排除，不能只依赖 Progman/WorkerW 类名。
            if (window == IntPtr.Zero || window == GetDesktopWindow() || window == GetShellWindow() ||
                !IsWindow(window) || IsIconic(window)) return false;
            uint processId;
            if (GetWindowThreadProcessId(window, out processId) == 0) return false;
            if (ignoreProcessId > 0 && processId == (uint)ignoreProcessId) return null;
            StringBuilder name = new StringBuilder(256);
            GetClassName(window, name, name.Capacity);
            string className = name.ToString();
            if (className == "Progman" || className == "WorkerW" || className == "Shell_TrayWnd" || className == "Shell_SecondaryTrayWnd") return false;
            Rect rect;
            if (!GetClientRect(window, out rect)) return false;
            Point origin = new Point();
            if (!ClientToScreen(window, ref origin)) return false;
            rect.Left += origin.X; rect.Right += origin.X;
            rect.Top += origin.Y; rect.Bottom += origin.Y;
            IntPtr monitor = MonitorFromWindow(window, 2);
            if (monitor == IntPtr.Zero) return false;
            MonitorInfo info = new MonitorInfo();
            info.Size = (uint)Marshal.SizeOf(typeof(MonitorInfo));
            if (!GetMonitorInfo(monitor, ref info)) return false;
            return FullscreenSurface(rect, info.Monitor, GetWindowStyle(window, -16));
        }

        static bool FullscreenSurface(Rect client, Rect monitor, uint style) {
            // 最大化外框可能覆盖整屏（尤其自动隐藏任务栏）；全屏要求无标题/缩放边框且客户区铺满屏幕。
            const uint frame = 0x00C00000u | 0x00040000u;
            const int tolerance = 2;
            return (style & frame) == 0 && client.Right > client.Left && client.Bottom > client.Top &&
                client.Left <= monitor.Left + tolerance && client.Top <= monitor.Top + tolerance &&
                client.Right >= monitor.Right - tolerance && client.Bottom >= monitor.Bottom - tolerance;
        }

        static void PollFullscreen() {
            bool? fullscreen = !state.Config.pauseOnFullscreen ? false : ReadFullscreen(GetForegroundWindow());
            if (!fullscreen.HasValue && !previousFullscreen.HasValue) fullscreen = false;
            if (fullscreen.HasValue && fullscreen != previousFullscreen) {
                previousFullscreen = fullscreen;
                Emit(fullscreen.Value ? "{\"type\":\"fullscreen\",\"fullscreen\":true}" : "{\"type\":\"fullscreen\",\"fullscreen\":false}");
            }
        }

        static void ValidateShortcut(ShortcutMember[] shortcut) {
            if (shortcut == null || shortcut.Length < 1 || shortcut.Length > 5) throw new InvalidOperationException("快捷键配置无效。");
            HashSet<int> ids = new HashSet<int>();
            int ordinary = 0;
            foreach (ShortcutMember member in shortcut) {
                if (member == null || String.IsNullOrWhiteSpace(member.code) || member.key <= 0 || member.key > 0x1FF ||
                    (member.key & 0xFF) == 0 || !ids.Add(member.key)) throw new InvalidOperationException("快捷键配置无效。");
                if (!member.modifier) ordinary++;
            }
            if (ordinary > 1) throw new InvalidOperationException("快捷键只能包含一个普通按键。");
        }

        static NativeConfig ParseConfiguration(Dictionary<string, object> command, JavaScriptSerializer serializer) {
            object request, pause, enabled, ownForeground, recording, shortcuts;
            if (!command.TryGetValue("requestId", out request) || !(request is string) || !ValidRequestId((string)request) ||
                !command.TryGetValue("pauseOnFullscreen", out pause) || !(pause is bool) ||
                !command.TryGetValue("inputEnabled", out enabled) || !(enabled is bool) ||
                !command.TryGetValue("allowOwnForeground", out ownForeground) || !(ownForeground is bool) ||
                !command.TryGetValue("recording", out recording) || !(recording is bool) ||
                !command.TryGetValue("shortcuts", out shortcuts)) throw new InvalidOperationException("原生助手配置格式无效。");
            NativeConfig config = new NativeConfig { requestId = (string)request, pauseOnFullscreen = (bool)pause,
                inputEnabled = (bool)enabled, allowOwnForeground = (bool)ownForeground, recording = (bool)recording,
                shortcuts = serializer.ConvertToType<ShortcutBindings>(shortcuts) };
            if (config.shortcuts == null) throw new InvalidOperationException("快捷键配置无效。");
            ValidateShortcut(config.shortcuts.prompt);
            if (config.shortcuts.graph != null) ValidateShortcut(config.shortcuts.graph);
            return config;
        }

        static void ApplyConfigurations() {
            NativeConfig next;
            while (pendingConfigurations.TryDequeue(out next)) {
                Decision decision = state.Apply(next, KeyIsDown);
                EmitTrigger(decision);
                PollFullscreen();
                Emit(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                    { "type", "configured" }, { "requestId", next.requestId }
                }));
            }
        }

        static void BeginSelections() {
            SelectionRequest request;
            while (pendingSelections.TryDequeue(out request)) {
                int started = 0;
                if (state.BeginSelection(request.Target)) { StopHoldTimer(); started = ++captureId; }
                Emit(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                    { "type", "selection-started" }, { "requestId", request.Id }, { "captureId", started }
                }));
            }
        }

        static void ReadCommands() {
            try {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    Dictionary<string, object> command = serializer.Deserialize<Dictionary<string, object>>(line);
                    object type;
                    if (command == null || !command.TryGetValue("type", out type))
                        throw new InvalidOperationException("原生助手配置格式无效。");
                    if (Object.Equals(type, "cancel-focus")) {
                        activeFocusRequest = null;
                        continue;
                    }
                    if (Object.Equals(type, "prepare-overlay-window")) {
                        object request, window;
                        if (!command.TryGetValue("requestId", out request) || !(request is string) || !ValidRequestId((string)request))
                            throw new InvalidOperationException("悬浮窗口请求编号无效。");
                        long handle;
                        bool prepared = command.TryGetValue("handle", out window) && window is string && TryHandle((string)window, out handle) && PrepareOverlayWindow(handle);
                        Emit(serializer.Serialize(new Dictionary<string, object> {
                            { "type", "overlay-window-prepared" }, { "requestId", request }, { "prepared", prepared }
                        }));
                        continue;
                    }
                    if (Object.Equals(type, "focus-window")) {
                        object request, window;
                        if (!command.TryGetValue("requestId", out request) || !(request is string) || !ValidRequestId((string)request))
                            throw new InvalidOperationException("焦点请求编号无效。");
                        string requestId = (string)request;
                        activeFocusRequest = requestId;
                        long handle;
                        if (!command.TryGetValue("handle", out window) || !(window is string) || !TryHandle((string)window, out handle)) {
                            EmitFocusResult(requestId, false);
                            continue;
                        }
                        ThreadPool.QueueUserWorkItem(delegate(object ignored) { FocusWorker(requestId, handle); });
                        continue;
                    }
                    if (Object.Equals(type, "cancel-capture")) {
                        object requested;
                        if (!command.TryGetValue("captureId", out requested) || !(requested is int) || (int)requested <= 0)
                            throw new InvalidOperationException("截图取消编号无效。");
                        PostThreadMessage(hookThread, WM_CANCEL_CAPTURE, new UIntPtr((uint)(int)requested), IntPtr.Zero);
                        continue;
                    }
                    if (Object.Equals(type, "begin-selection")) {
                        object request, target;
                        if (!command.TryGetValue("requestId", out request) || !(request is string) || !ValidRequestId((string)request) ||
                            !command.TryGetValue("target", out target) || !(Object.Equals(target, "prompt") || Object.Equals(target, "graph")))
                            throw new InvalidOperationException("屏幕框选请求编号无效。");
                        pendingSelections.Enqueue(new SelectionRequest { Id = (string)request, Target = (string)target });
                        PostThreadMessage(hookThread, WM_BEGIN_SELECTION, UIntPtr.Zero, IntPtr.Zero);
                        continue;
                    }
                    if (!Object.Equals(type, "configure"))
                        throw new InvalidOperationException("原生助手配置格式无效。");
                    pendingConfigurations.Enqueue(ParseConfiguration(command, serializer));
                    PostThreadMessage(hookThread, WM_CONFIGURE, UIntPtr.Zero, IntPtr.Zero);
                }
            } catch { failure = "无法读取原生助手配置。"; }
            finally {
                activeFocusRequest = null;
                PostThreadMessage(hookThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
            }
        }

        public static void Run(int ignoredProcessId) {
            ignoreProcessId = ignoredProcessId;
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero)
                throw new InvalidOperationException("无法启用屏幕像素坐标模式。");
            state = new TriggerState();
            output = new BlockingCollection<string>();
            Thread writer = new Thread(delegate() {
                try {
                    foreach (string line in output.GetConsumingEnumerable()) { Console.Out.WriteLine(line); Console.Out.Flush(); }
                } catch (System.IO.IOException) {
                    failure = "原生助手输出通道已关闭。";
                    PostThreadMessage(hookThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
                }
            });
            writer.IsBackground = true;
            writer.Start();
            hookThread = GetCurrentThreadId();
            Message message;
            PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
            UIntPtr timer = UIntPtr.Zero;
            try {
                keyboardCallback = Keyboard;
                mouseCallback = Mouse;
                keyboardHook = SetWindowsHookEx(13, keyboardCallback, GetModuleHandle(null), 0);
                if (keyboardHook == IntPtr.Zero) throw new InvalidOperationException("无法安装快捷键监听。");
                mouseHook = SetWindowsHookEx(14, mouseCallback, GetModuleHandle(null), 0);
                if (mouseHook == IntPtr.Zero) throw new InvalidOperationException("无法安装鼠标监听。");
                timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 500, IntPtr.Zero);
                if (timer == UIntPtr.Zero) throw new InvalidOperationException("无法启动全屏检测。");
                PollFullscreen();
                Emit("{\"type\":\"ready\"}");
                Thread reader = new Thread(ReadCommands);
                reader.IsBackground = true;
                reader.Start();
                int result;
                while ((result = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0) {
                    if (message.Id == WM_TIMER && holdTimer != UIntPtr.Zero && message.WParam == holdTimer) {
                        if (holdCaptureId == captureId) EmitTrigger(state.Hold(clock.ElapsedMilliseconds));
                    }
                    else if (message.Id == WM_CANCEL_CAPTURE) {
                        if (ShouldCancel(unchecked((int)message.WParam.ToUInt64()), captureId)) EmitTrigger(state.CancelCapture());
                    }
                    else if (message.Id == WM_CONFIGURE) ApplyConfigurations();
                    else if (message.Id == WM_BEGIN_SELECTION) BeginSelections();
                    else if (message.Id == WM_TIMER && message.WParam == timer) PollFullscreen();
                    else { TranslateMessage(ref message); DispatchMessage(ref message); }
                }
                if (result == -1) throw new InvalidOperationException("原生消息循环中断。");
                if (failure != null) throw new InvalidOperationException(failure);
            } finally {
                activeFocusRequest = null;
                EmitTrigger(state.CancelCapture());
                StopHoldTimer();
                if (timer != UIntPtr.Zero) KillTimer(IntPtr.Zero, timer);
                if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
                if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
                output.CompleteAdding();
                writer.Join(500);
                GC.KeepAlive(keyboardCallback);
                GC.KeepAlive(mouseCallback);
            }
        }

        static int assertions;
        static void Assert(bool value) { assertions++; if (!value) throw new InvalidOperationException("原生输入状态机自检失败：" + assertions); }
        static ShortcutMember Mod(int id) { return new ShortcutMember { code = "test-mod-" + id, key = id, modifier = true }; }
        static ShortcutMember MainKey(int id) { return new ShortcutMember { code = "test-key-" + id, key = id }; }
        static NativeConfig TestConfig(params ShortcutMember[] members) {
            return new NativeConfig { requestId = "test-config", inputEnabled = true, shortcuts = new ShortcutBindings { prompt = members } };
        }
        static TriggerState Configured(params ShortcutMember[] members) {
            TriggerState result = new TriggerState();
            result.Apply(TestConfig(members));
            return result;
        }
        static NativeConfig DualConfig(ShortcutMember[] prompt, ShortcutMember[] graph) {
            NativeConfig result = TestConfig(prompt);
            result.shortcuts.graph = graph;
            return result;
        }
        static TriggerState DualConfigured(ShortcutMember[] prompt, ShortcutMember[] graph) {
            TriggerState result = new TriggerState();
            result.Apply(DualConfig(prompt, graph));
            return result;
        }
        static KeyboardHook Raw(int id) {
            return new KeyboardHook { Key = MapVirtualKey((uint)(id & 0xFF) | ((id & 0x100) != 0 ? 0xE000u : 0u), 3),
                Scan = (uint)(id & 0x2FF), Flags = (id & 0x100) != 0 ? 1u : 0u };
        }
        static KeyboardHook VirtualRaw(uint key, uint flags = 0x10) { return new KeyboardHook { Key = key, Flags = flags }; }
        static Decision Down(TriggerState state, int id, long time = 0) { return state.Key(Raw(id), true, time, delegate { return true; }); }
        static Decision Up(TriggerState state, int id, long time = 0) { return state.Key(Raw(id), false, time, delegate { return true; }); }
        static Decision Button(TriggerState state, int button, bool down, long time) { return state.Mouse(button, down, time); }

        public static void Validate() {
            // 只运行状态机、窗口分类、坐标和序列化测试，不安装 hook 或发送真实输入。
            TriggerState state;
            Decision decision;
            foreach (IntPtr desktop in new IntPtr[] { IntPtr.Zero, GetDesktopWindow(), GetShellWindow() }) {
                Assert(ReadFullscreen(desktop) == false);
                state = Configured(MainKey(0x42));
                decision = state.Key(Raw(0x42), true, 0, delegate { return ReadFullscreen(desktop) != true; });
                Assert(decision.Begin && decision.Suppress);
                Assert(Up(state, 0x42, 100).End);
            }
            Rect monitor = new Rect { Left = -1920, Top = -1080, Right = 0, Bottom = 0 };
            Assert(FullscreenSurface(monitor, monitor, 0x80000000u));
            Assert(!FullscreenSurface(monitor, monitor, 0x00CF0000u));
            Assert(!FullscreenSurface(monitor, monitor, 0x00040000u));
            Assert(!FullscreenSurface(new Rect { Left = -1920, Top = -1050, Right = 0, Bottom = 0 }, monitor, 0));
            Assert(!FullscreenSurface(new Rect { Left = -1920, Top = -1080, Right = 0, Bottom = -48 }, monitor, 0));
            Assert(!FullscreenSurface(new Rect(), monitor, 0));

            // 专用键的 down/repeat/up 全部吞下，短按和长按各只发一次事件。
            foreach (int id in new int[] { 1, 0x38, 0x138, 0x1D, 0x11D, 0x2A, 0x36, 0x15B, 0x15C, 0x42, 0x6D }) {
                state = Configured(MainKey(id));
                decision = Down(state, id);
                Assert(decision.Begin && decision.Suppress && !decision.Hold);
                decision = Down(state, id, 100);
                Assert(decision.Suppress && !decision.Begin);
                Assert(!state.Hold(499).Hold);
                decision = Up(state, id, 499);
                Assert(decision.End && decision.Suppress && !decision.Hold);
                Assert(!state.Hold(500).Hold);
                Assert(Down(state, id, 600).Begin);
                Assert(state.Hold(1100).Hold && !state.Hold(1101).Hold);
                decision = Up(state, id, 1200);
                Assert(decision.End && decision.Suppress && !decision.Hold);
                Assert(Down(state, id, 1300).Begin);
                decision = Up(state, id, 1800);
                Assert(decision.Hold && decision.End && decision.Suppress);
            }

            // 无关键没有账本；即使缺少 up，也不能改变专用键的短按、长按或组合。
            foreach (int other in new int[] { 0xF, 0x1D, 0x2A, 0x2E, 0x6D, 0x15B, 0x153, 0x21D }) {
                state = Configured(Mod(0x38));
                Assert(!Down(state, other).Suppress);
                Assert(Down(state, 0x38, 10).Begin);
                decision = Down(state, other, 20);
                Assert(!decision.Suppress && !decision.Cancel);
                Assert(!Down(state, other, 30).Suppress);
                Assert(!Up(state, other, 40).Suppress);
                Assert(state.Hold(510).Hold);
                Assert(Up(state, 0x38, 600).End);
                Assert(Down(state, 0x38, 700).Begin && Up(state, 0x38, 701).End);
            }
            state = Configured(Mod(0x38));
            Assert(!state.Key(VirtualRaw(0xE5), true, 0, delegate { return true; }).Suppress);
            Assert(Down(state, 0x38).Begin && Up(state, 0x38, 1).End);

            // 组合成员都为专用键，普通成员可先按，无关普通键、修饰键和鼠标均不参与凑齐。
            foreach (bool reverse in new bool[] { false, true }) {
                int first = reverse ? 0x25 : 0x1D, last = reverse ? 0x1D : 0x25;
                state = Configured(Mod(0x1D), MainKey(0x25));
                Down(state, 0x2E);
                decision = Down(state, first, 10);
                Assert(decision.Suppress && !decision.Begin);
                Assert(!Button(state, 2, true, 20).Suppress);
                Assert(!Button(state, 2, false, 21).Suppress);
                Assert(!Down(state, 0x2A, 30).Suppress);
                decision = Down(state, last, 40);
                Assert(decision.Suppress && decision.Begin);
                Assert(!Down(state, 0xF, 50).Cancel);
                Assert(Up(state, first, 60).End);
                Assert(!Down(state, first, 70).Begin);
                Assert(Up(state, last, 80).Suppress && Up(state, first, 90).Suppress);
                Assert(!Down(state, first, 100).Begin && Down(state, last, 110).Begin);
                Up(state, first, 120); Up(state, last, 121);
            }
            state = Configured(Mod(0x1D), MainKey(0x25));
            Assert(Down(state, 0x1D).Suppress && Up(state, 0x1D, 1).Suppress);
            Assert(!state.Hold(500).Hold);

            // 两路独立监听；一轮开始后只由所属组合结束，另一组合不会改派目标。
            foreach (bool graphFirst in new bool[] { false, true }) {
                int first = graphFirst ? 0x138 : 0x38, other = graphFirst ? 0x38 : 0x138;
                string target = graphFirst ? "graph" : "prompt";
                state = DualConfigured(new[] { Mod(0x38) }, new[] { Mod(0x138) });
                decision = Down(state, first);
                Assert(decision.Begin && decision.Target == target);
                decision = Down(state, other, 10);
                Assert(decision.Suppress && !decision.Begin && decision.Target == target);
                decision = Up(state, other, 20);
                Assert(decision.Suppress && !decision.End && decision.Target == target);
                decision = state.Hold(500);
                Assert(decision.Hold && decision.Target == target);
                decision = Up(state, first, 501);
                Assert(decision.End && decision.Target == target);
                decision = Down(state, other, 510);
                Assert(decision.Begin && decision.Target == (graphFirst ? "prompt" : "graph"));
                decision = state.CancelCapture();
                Assert(decision.Cancel && decision.Target == (graphFirst ? "prompt" : "graph"));
                Assert(!Up(state, other, 520).End);
            }
            // 相同组合只派给图谱；关闭图谱后本体恢复，旧吞键仍须配对释放。
            state = DualConfigured(new[] { Mod(0x38) }, new[] { Mod(0x38) });
            decision = Down(state, 0x38);
            Assert(decision.Begin && decision.Target == "graph" && !decision.Waiting);
            decision = state.Apply(TestConfig(Mod(0x38)));
            Assert(decision.Cancel && decision.Target == "graph");
            Assert(!Down(state, 0x38, 1).Begin && Up(state, 0x38, 2).Suppress);
            decision = Down(state, 0x38, 3);
            Assert(decision.Begin && decision.Target == "prompt");

            // Alt 与 Alt+G 这类前缀关系仅延迟短组合；长组合从凑齐时开始计时。
            foreach (bool shortIsGraph in new bool[] { false, true }) {
                ShortcutMember[] shorter = new[] { Mod(0x38) }, longer = new[] { Mod(0x38), MainKey(0x22) };
                ShortcutMember[] prompt = shortIsGraph ? longer : shorter, graph = shortIsGraph ? shorter : longer;
                string shortTarget = shortIsGraph ? "graph" : "prompt", longTarget = shortIsGraph ? "prompt" : "graph";
                state = DualConfigured(prompt, graph);
                decision = Down(state, 0x38);
                Assert(decision.Waiting && !decision.Begin && decision.Suppress && !state.BeginSelection("graph"));
                decision = Up(state, 0x38, 200);
                Assert(decision.Begin && decision.End && !decision.Hold && decision.Target == shortTarget);
                Assert(!state.Hold(500).Hold);
                Assert(Down(state, 0x38, 600).Waiting);
                decision = Down(state, 0x22, 900);
                Assert(decision.Begin && !decision.Hold && decision.Target == longTarget);
                Assert(!state.Hold(1100).Hold && !state.Hold(1399).Hold);
                decision = state.Hold(1400);
                Assert(decision.Hold && decision.Target == longTarget);
                Assert(Up(state, 0x22, 1401).End && Up(state, 0x38, 1402).Suppress);
                // 长按开始后补按另一组合仍保持当前目标，包括尚未处理 timer 的边界。
                Assert(Down(state, 0x38, 1500).Waiting);
                decision = Down(state, 0x22, 2000);
                Assert(decision.Begin && decision.Hold && decision.Target == shortTarget);
                Assert(!Up(state, 0x22, 2001).End);
                decision = Up(state, 0x38, 2002);
                Assert(decision.End && decision.Target == shortTarget);
                Assert(Down(state, 0x22, 2100).Suppress);
                decision = Down(state, 0x38, 2101);
                Assert(decision.Begin && decision.Target == longTarget);
                Up(state, 0x38, 2102); Up(state, 0x22, 2103);
                Assert(Down(state, 0x38, 2200).Waiting);
                decision = Button(state, 1, true, 2700);
                Assert(decision.Begin && decision.Hold && decision.SelectionDown && decision.Target == shortTarget);
                Assert(Button(state, 1, false, 2701).SelectionUp);
                Up(state, 0x38, 2702);
                Assert(Down(state, 0x38, 2800).Waiting);
                decision = Button(state, 1, true, 2801);
                Assert(!decision.Suppress && !decision.SelectionDown && !decision.Begin);
                Assert(!Button(state, 1, false, 2802).Suppress);
                decision = Down(state, 1, 2803);
                Assert(decision.StopTimer && decision.Suppress && !decision.Cancel && !decision.Begin);
                Assert(Up(state, 1, 2804).Suppress && !Up(state, 0x38, 2805).End && !state.Hold(3300).Hold);
                Assert(Down(state, 0x38, 3400).Waiting);
                decision = state.Apply(TestConfig(Mod(0x38)));
                Assert(decision.StopTimer && !decision.Cancel && !state.Hold(3900).Hold);
            }
            // 图谱的右 Alt 同样消费 AltGr 的模拟 Ctrl；录制与 input gate 同时阻断两路。
            state = DualConfigured(new[] { Mod(0x38) }, new[] { Mod(0x138) });
            Assert(Down(state, 0x21D).Suppress);
            decision = Down(state, 0x138, 1);
            Assert(decision.Begin && decision.Target == "graph");
            Assert(Up(state, 0x138, 2).End && Up(state, 0x21D, 3).Suppress);
            state.Key(Raw(0x21D), true, 4, delegate { return false; });
            Assert(!Down(state, 0x138, 5).Begin && !Up(state, 0x138, 6).Suppress && !Up(state, 0x21D, 7).Suppress);
            NativeConfig dualRecording = DualConfig(new[] { Mod(0x38) }, new[] { Mod(0x138) });
            dualRecording.recording = true;
            state.Apply(dualRecording);
            Assert(!Down(state, 0x38, 8).Suppress && !Down(state, 0x138, 9).Suppress);
            Assert(!Up(state, 0x38, 10).Suppress && !Up(state, 0x138, 11).Suppress);
            state = new TriggerState();
            state.Apply(DualConfig(new[] { Mod(0x38) }, new[] { Mod(0x138) }), delegate { return true; });
            Assert(!Down(state, 0x38).Begin && !Down(state, 0x138).Begin);
            Assert(!Up(state, 0x38, 1).Suppress && !Up(state, 0x138, 2).Suppress);
            decision = Down(state, 0x138, 3);
            Assert(decision.Begin && decision.Target == "graph");

            // gate 拒绝和录制/禁用状态均保持整次透传，恢复后等待一次新按压。
            state = Configured(Mod(0x38));
            int checks = 0;
            decision = state.Key(Raw(0x38), true, 0, delegate { checks++; return false; });
            Assert(!decision.Begin && !decision.Suppress && checks == 1);
            decision = state.Key(Raw(0x38), true, 1, delegate { checks++; return true; });
            Assert(!decision.Begin && !decision.Suppress && checks == 1);
            Assert(!Up(state, 0x38, 2).Suppress);
            Assert(Down(state, 0x38, 3).Begin && Up(state, 0x38, 4).Suppress);
            foreach (bool recording in new bool[] { false, true }) {
                NativeConfig bypass = TestConfig(Mod(0x38));
                bypass.recording = recording; bypass.inputEnabled = recording;
                state = new TriggerState(); state.Apply(bypass);
                Assert(!Down(state, 0x38).Suppress);
                state.Apply(TestConfig(Mod(0x38)));
                Assert(!Down(state, 0x38, 1).Suppress && !Up(state, 0x38, 2).Suppress);
                Assert(Down(state, 0x38, 3).Begin);
                Assert(state.Apply(bypass).Cancel);
                Assert(Down(state, 0x38, 4).Suppress && Up(state, 0x38, 5).Suppress);
                Assert(!Down(state, 0x38, 6).Suppress && !Up(state, 0x38, 7).Suppress);
            }

            // 配置 barrier 取消捕获，旧吞键只配对其 up；新配置不被旧键阻塞。
            state = Configured(Mod(0x38));
            Down(state, 0x38);
            Assert(state.Apply(TestConfig(MainKey(0x42))).Cancel);
            Assert(Down(state, 0x38, 1).Suppress);
            Assert(Down(state, 0x42, 2).Begin);
            Assert(Up(state, 0x38, 3).Suppress);
            Assert(Up(state, 0x42, 4).End);
            Assert(!Down(state, 0x38, 5).Suppress && !Up(state, 0x38, 6).Suppress);
            state = Configured(Mod(0x38));
            Down(state, 0x38);
            NativeConfig ownForeground = TestConfig(Mod(0x38)); ownForeground.allowOwnForeground = true;
            Assert(!state.Apply(ownForeground).Cancel && state.Hold(500).Hold && Up(state, 0x38, 501).End);
            state = Configured(Mod(0x1D), MainKey(0x25));
            Down(state, 0x1D);
            Assert(!state.Apply(TestConfig(MainKey(0x25), Mod(0x1D))).Cancel);
            Assert(Down(state, 0x25).Begin);

            // 只采样配置键：无关 F22 即使系统报告按住也从未查询、从未阻塞。
            state = new TriggerState();
            int samples = 0;
            state.Apply(TestConfig(Mod(0x38)), delegate(uint key) { samples++; Assert(key == 0xA4); return false; });
            Assert(samples == 1 && Down(state, 0x38).Begin && Up(state, 0x38, 1).End);
            foreach (int id in new int[] { 0x38, 0x138, 0x1D, 0x11D, 0x42, 0x6D }) {
                state = new TriggerState();
                state.Apply(TestConfig(MainKey(id)), delegate { return true; });
                Assert(!Down(state, id).Suppress && !Down(state, id, 1).Begin);
                Assert(!Up(state, id, 2).Suppress);
                Assert(Down(state, id, 3).Begin && Up(state, id, 4).End);
                state = new TriggerState();
                state.Apply(TestConfig(MainKey(id)), delegate { return true; });
                state.ReleaseSeededKeys(delegate { return true; });
                Assert(!Down(state, id).Begin);
                state.ReleaseSeededKeys(delegate { return false; });
                Assert(Down(state, id, 1).Begin && Up(state, id, 2).End);
            }
            // 配置切换新键已按住时同样等待释放；seed 扫描码别名只清启动项。
            state = Configured(Mod(0x38));
            state.Apply(TestConfig(MainKey(0x42)), delegate { return true; });
            Assert(!Down(state, 0x42).Begin && !Up(state, 0x42, 1).Suppress);
            Assert(Down(state, 0x42, 2).Begin);
            state = new TriggerState();
            state.Apply(TestConfig(MainKey(0x14F)), delegate { return true; });
            KeyboardHook numpadEnd = Raw(0x4F); numpadEnd.Key = 0x23;
            state.Key(numpadEnd, false, 0, delegate { return true; });
            Assert(Down(state, 0x14F, 1).Begin);

            // 系统注入的零扫描码事件仍能与物理 up 配对，不会吞掉其它扫描码。
            foreach (int[] entry in new int[][] {
                new int[] { 0x12, 0x30, 0x38 }, new int[] { 0xA4, 0x10, 0x38 },
                new int[] { 0x12, 0x31, 0x138 }, new int[] { 0xA5, 0x10, 0x138 },
                new int[] { 0x11, 0x10, 0x1D }, new int[] { 0xA3, 0x10, 0x11D },
                new int[] { 0x4B, 0x10, 0x25 }, new int[] { 0x77, 0x10, 0x42 },
                new int[] { 0x0D, 0x10, 0x1C }, new int[] { 0x0D, 0x11, 0x11C },
                new int[] { 0x2E, 0x11, 0x153 } }) {
                KeyboardHook virtualKey = VirtualRaw((uint)entry[0], (uint)entry[1]);
                Assert(KeyId(virtualKey) == entry[2]);
                state = Configured(MainKey(entry[2]));
                decision = state.Key(virtualKey, true, 0, delegate { return true; });
                Assert(decision.Begin && decision.Suppress);
                Assert(Up(state, entry[2], 1).End);
                Assert(Down(state, entry[2], 2).Begin);
                decision = state.Key(virtualKey, false, 3, delegate { return true; });
                Assert(decision.End && decision.Suppress);
            }

            // 右 Alt 专用时连同 AltGr 模拟 Ctrl 吞下；未配置右 Alt 时完整透传。
            state = Configured(Mod(0x138));
            Assert(Down(state, 0x21D).Suppress);
            Assert(Down(state, 0x138, 1).Begin);
            Assert(!Down(state, 0x12, 2).Suppress && !Down(state, 0x12, 2).Cancel);
            Assert(Up(state, 0x138, 3).End && Up(state, 0x21D, 4).Suppress);
            Assert(Down(state, 0x138, 5).Begin && Up(state, 0x138, 6).End);
            state = Configured(Mod(0x38));
            Assert(!Down(state, 0x21D).Suppress && !Down(state, 0x138, 1).Suppress);
            Assert(Down(state, 0x38, 2).Begin && Up(state, 0x38, 3).End);
            Assert(!Up(state, 0x138, 4).Suppress && !Up(state, 0x21D, 5).Suppress);
            state = Configured(Mod(0x138));
            state.Key(Raw(0x21D), true, 0, delegate { return false; });
            Assert(!Down(state, 0x138, 1).Suppress);
            Assert(!Up(state, 0x138, 2).Suppress && !Up(state, 0x21D, 3).Suppress);
            Assert(Down(state, 0x21D, 4).Suppress && Down(state, 0x138, 5).Begin);

            // 鼠标只在长按后的左键选择中吞输入，其余按钮和移动不取消激活。
            state = Configured(Mod(0x38)); Down(state, 0x38);
            foreach (int button in new int[] { 0, 1, 2, 3, 4, 5 }) {
                decision = Button(state, button, true, 100);
                Assert(!decision.Suppress && !decision.Cancel);
                Assert(!Button(state, button, false, 101).Suppress);
            }
            decision = Button(state, 1, true, 500);
            Assert(decision.Hold && decision.SelectionDown && decision.Suppress);
            decision = Button(state, 1, false, 501);
            Assert(decision.SelectionUp && decision.Suppress);
            Assert(!state.Hold(600).Hold);
            Button(state, 1, true, 601);
            Assert(Up(state, 0x38, 602).End);
            decision = Button(state, 1, false, 603);
            Assert(decision.Suppress && !decision.SelectionUp);
            Assert(!Button(state, 1, true, 604).Suppress && !Button(state, 1, false, 605).Suppress);
            state = Configured(Mod(0x38)); Down(state, 0x38); Button(state, 1, true, 500);
            Assert(state.CancelCapture().Cancel);
            Assert(!state.CancelCapture().Cancel && !state.Hold(600).Hold);
            Assert(Button(state, 1, false, 601).Suppress && Up(state, 0x38, 602).Suppress);

            // Escape 整次吞下并只取消一次；后续专用键释放不再发 End。
            state = Configured(Mod(0x38)); Down(state, 0x38); Button(state, 1, true, 500);
            decision = Down(state, 1, 501);
            Assert(decision.Cancel && decision.Suppress);
            Assert(Down(state, 1, 502).Suppress && !Down(state, 1, 503).Cancel);
            Assert(Up(state, 1, 504).Suppress);
            Assert(Button(state, 1, false, 505).Suppress);
            decision = Up(state, 0x38, 506);
            Assert(decision.Suppress && !decision.End && !decision.Hold);
            Assert(!Down(state, 1, 507).Suppress && !Up(state, 1, 508).Suppress);
            Assert(Down(state, 0x38, 509).Begin);

            // 相机入口不需要按住激活键；单次拖拽提交后自动结束，重复启动不替换当前捕获。
            state = Configured(Mod(0x38));
            Assert(state.BeginSelection("graph") && !state.BeginSelection("prompt"));
            Assert(!state.Hold(1000).Hold);
            decision = Down(state, 0x38);
            Assert(decision.Suppress && !decision.Begin);
            decision = Up(state, 0x38, 1);
            Assert(decision.Suppress && !decision.End);
            decision = Button(state, 1, true, 2);
            Assert(decision.Suppress && decision.SelectionDown && !decision.Begin && !decision.Hold);
            decision = Button(state, 1, false, 3);
            Assert(decision.Suppress && decision.SelectionUp && decision.End && !decision.Hold && decision.Target == "graph");
            Assert(!Button(state, 1, true, 4).Suppress && !Button(state, 1, false, 5).Suppress);
            Assert(!state.CancelCapture().Cancel);
            Assert(Down(state, 0x38, 6).Begin && !state.BeginSelection("graph"));
            Assert(Up(state, 0x38, 7).End && state.BeginSelection("prompt"));

            // Escape 即使本身是配置键也取消手动框选；取消拖拽后仍吞掉配对的鼠标释放。
            foreach (int shortcut in new int[] { 1, 0x38 }) {
                state = Configured(MainKey(shortcut));
                Assert(state.BeginSelection("graph"));
                Assert(Button(state, 1, true, 0).SelectionDown);
                decision = Down(state, 1, 1);
                Assert(decision.Suppress && decision.Cancel);
                Assert(!state.BeginSelection("prompt"));
                decision = Button(state, 1, false, 2);
                Assert(decision.Suppress && !decision.SelectionUp && !decision.End);
                Assert(Up(state, 1, 3).Suppress && state.BeginSelection("graph"));
                Assert(state.CancelCapture().Cancel && !state.CancelCapture().Cancel);
            }
            foreach (bool recording in new bool[] { false, true }) {
                state = Configured(Mod(0x38));
                Assert(state.BeginSelection("graph"));
                NativeConfig disabled = TestConfig(Mod(0x38));
                disabled.inputEnabled = recording; disabled.recording = recording;
                Assert(state.Apply(disabled).Cancel);
                Assert(!state.BeginSelection("graph") && !Button(state, 1, true, 0).Suppress);
                state.Apply(TestConfig(Mod(0x38)));
                Assert(state.BeginSelection("graph"));
                Assert(state.CancelCapture().Cancel);
            }

            // 回执与真实输出路径共用：先回编号，最后一次 pointer-up 必须早于 trigger-end。
            WindowsNative.state = Configured(Mod(0x38));
            output = new BlockingCollection<string>();
            pendingSelections.Enqueue(new SelectionRequest { Id = "manual-start", Target = "graph" }); BeginSelections();
            JavaScriptSerializer manualParser = new JavaScriptSerializer();
            Dictionary<string, object> manualAck = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
            Assert(Object.Equals(manualAck["type"], "selection-started") && Object.Equals(manualAck["requestId"], "manual-start"));
            Assert(Object.Equals(manualAck["captureId"], captureId) && captureId > 0);
            EmitMouseDecision(Button(WindowsNative.state, 1, true, 0), new Point { X = -100, Y = 30 }, true);
            EmitMouseDecision(Button(WindowsNative.state, 1, false, 1), new Point { X = 300, Y = 230 }, false);
            Dictionary<string, object> manualDown = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
            Dictionary<string, object> manualUp = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
            Dictionary<string, object> manualEnd = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
            Assert(Object.Equals(manualDown["type"], "selection-pointer") && Object.Equals(manualDown["phase"], "down") && Object.Equals(manualDown["x"], -100));
            Assert(Object.Equals(manualUp["type"], "selection-pointer") && Object.Equals(manualUp["phase"], "up") && Object.Equals(manualUp["y"], 230));
            Assert(Object.Equals(manualEnd["type"], "trigger-end") && Object.Equals(manualEnd["captureId"], captureId) && Object.Equals(manualEnd["target"], "graph"));
            Assert(output.Count == 0);
            // 普通点击和释放都携带物理坐标；移动与滚轮不生成按键通知。
            EmitMouseDecision(Button(WindowsNative.state, 1, true, 2), new Point { X = -640, Y = 210 }, true);
            EmitMouseDecision(Button(WindowsNative.state, 1, false, 3), new Point { X = -630, Y = 220 }, false);
            EmitMouseDecision(Button(WindowsNative.state, 2, true, 4), new Point { X = 1920, Y = -50 }, true);
            Dictionary<string, object> firstClick = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
            Dictionary<string, object> firstRelease = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
            Dictionary<string, object> secondClick = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
            Assert(Object.Equals(firstClick["type"], "pointer-down") && Object.Equals(firstClick["x"], -640) && Object.Equals(firstClick["y"], 210));
            Assert(Object.Equals(firstRelease["type"], "pointer-up") && Object.Equals(firstRelease["x"], -630) && Object.Equals(firstRelease["y"], 220));
            Assert(Object.Equals(secondClick["type"], "pointer-down") && Object.Equals(secondClick["x"], 1920) && Object.Equals(secondClick["y"], -50));
            EmitMouseDecision(Button(WindowsNative.state, 0, false, 5), new Point { X = 1940, Y = -40 }, false, 0);
            Assert(output.Count == 0);
            // 前缀候选不发启动事件，但隔离上一轮编号；选定后的全部事件携带同一目标。
            WindowsNative.state = DualConfigured(new[] { Mod(0x38) }, new[] { Mod(0x38), MainKey(0x22) });
            int previousCaptureId = captureId;
            EmitTrigger(Down(WindowsNative.state, 0x38));
            Assert(output.Count == 0 && holdTimer != UIntPtr.Zero && !ShouldCancel(previousCaptureId, captureId));
            EmitTrigger(Up(WindowsNative.state, 0x38, 100));
            Dictionary<string, object> shortBegin = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
            Dictionary<string, object> shortEnd = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
            Assert(Object.Equals(shortBegin["type"], "trigger-begin") && Object.Equals(shortBegin["target"], "prompt") && Object.Equals(shortBegin["captureId"], captureId));
            Assert(Object.Equals(shortEnd["type"], "trigger-end") && Object.Equals(shortEnd["target"], "prompt") && Object.Equals(shortEnd["captureId"], captureId));
            Assert(output.Count == 0 && holdTimer == UIntPtr.Zero);
            EmitTrigger(Down(WindowsNative.state, 0x38, 200));
            EmitTrigger(Down(WindowsNative.state, 0x22, 300));
            EmitTrigger(WindowsNative.state.Hold(800));
            EmitTrigger(WindowsNative.state.CancelCapture());
            foreach (string eventType in new[] { "trigger-begin", "trigger-hold", "trigger-cancel" }) {
                Dictionary<string, object> targetEvent = manualParser.Deserialize<Dictionary<string, object>>(output.Take());
                Assert(Object.Equals(targetEvent["type"], eventType) && Object.Equals(targetEvent["target"], "graph") && Object.Equals(targetEvent["captureId"], captureId));
            }
            Assert(output.Count == 0 && holdTimer == UIntPtr.Zero);
            output.Dispose(); output = null;

            // 原有编号、焦点句柄边界与 JSON 转义验证继续保留。
            Assert(!ShouldCancel(1, 2) && ShouldCancel(2, 2) && !ShouldCancel(0, 2) && !ShouldCancel(0, 0) && !ShouldCancel(-1, 2));
            Assert(ValidRequestId("d430a1d8-664a-4979-a506-3934f7d49bd6"));
            Assert(!ValidRequestId(null) && !ValidRequestId("") && !ValidRequestId("  ") && !ValidRequestId(new string('x', 129)));
            long parsedHandle;
            Assert(TryHandle("123456", out parsedHandle) && parsedHandle == 123456);
            Assert(!TryHandle("0", out parsedHandle) && !TryHandle("-1", out parsedHandle));
            Assert(!TryHandle("+1", out parsedHandle) && !TryHandle(" 1", out parsedHandle));
            Assert(!TryHandle("1.0", out parsedHandle) && !TryHandle("0x123", out parsedHandle));
            Assert(!TryHandle("9223372036854775808", out parsedHandle));
            Assert(OwnsVisibleTarget(12, 12, true, true) && !OwnsVisibleTarget(0, 0, true, true));
            Assert(!OwnsVisibleTarget(12, 13, true, true));
            Assert(!OwnsVisibleTarget(12, 12, false, true) && !OwnsVisibleTarget(12, 12, true, false));
            // 焦点回退只验证真实执行策略与输入布局，替身不会向桌面发送按键。
            Assert(Marshal.SizeOf(typeof(Input)) == (IntPtr.Size == 8 ? 40 : 28));
            Assert(Marshal.OffsetOf(typeof(Input), "Data").ToInt32() == (IntPtr.Size == 8 ? 8 : 4));
            Input[] wakeKeys = FocusAltInputs();
            Assert(wakeKeys.Length == 2 && wakeKeys[0].Type == 1 && wakeKeys[1].Type == 1);
            Assert(wakeKeys[0].Data.Keyboard.Key == 0xA4 && wakeKeys[0].Data.Keyboard.Flags == 0);
            Assert(wakeKeys[1].Data.Keyboard.Key == 0xA4 && wakeKeys[1].Data.Keyboard.Flags == 2);
            foreach (Input input in wakeKeys) {
                Assert(input.Data.Keyboard.Extra == focusInputMarker);
                Assert(FocusInput(new KeyboardHook { Key = 0xA4, Flags = 0x10, Extra = input.Data.Keyboard.Extra }));
            }
            Assert(!FocusInput(new KeyboardHook { Key = 0xA4, Extra = focusInputMarker }));
            Assert(!FocusInput(new KeyboardHook { Key = 0xA4, Flags = 0x10, Extra = new UIntPtr(1) }));
            state = Configured(Mod(0x38));
            Assert(state.Key(VirtualRaw(0xA4), true, 0, delegate { return true; }).Begin);
            Assert(state.Key(VirtualRaw(0xA4), false, 1, delegate { return true; }).End);
            foreach (int modifier in new int[] { 0x2A, 0x36, 0x1D, 0x11D, 0x38, 0x138, 0x15B, 0x15C }) {
                state = Configured(Mod(modifier));
                Down(state, modifier);
                Assert(state.SuppressedModifierDown && ModifiersDown(state.SuppressedModifierDown, delegate { return false; }));
                Up(state, modifier, 1);
                Assert(!state.SuppressedModifierDown && !ModifiersDown(state.SuppressedModifierDown, delegate { return false; }));
            }
            foreach (uint modifier in new uint[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
                Assert(ModifiersDown(false, delegate(uint key) { return key == modifier; }));
            state = Configured(MainKey(0x42));
            Down(state, 0x42); Assert(!state.SuppressedModifierDown);

            int injections = 0, activations = 0;
            activeFocusRequest = "focus-test";
            bool targetExists = true, targetVisible = true, modifierHeld = false;
            uint targetOwner = 12;
            Func<bool> currentTarget = delegate { return CurrentFocusRequest("focus-test") && OwnsVisibleTarget(12, targetOwner, targetExists, targetVisible); };
            Func<bool> heldModifier = delegate { return modifierHeld; };
            Func<Input[], uint> sendWake = delegate(Input[] inputs) { injections++; return (uint)inputs.Length; };
            Action activate = delegate { activations++; };
            activeFocusRequest = null;
            RetryForegroundWithAlt(currentTarget, heldModifier, sendWake, activate);
            activeFocusRequest = "new-request";
            RetryForegroundWithAlt(currentTarget, heldModifier, sendWake, activate);
            activeFocusRequest = "focus-test"; targetOwner = 13;
            RetryForegroundWithAlt(currentTarget, heldModifier, sendWake, activate);
            targetOwner = 12; targetVisible = false;
            RetryForegroundWithAlt(currentTarget, heldModifier, sendWake, activate);
            targetVisible = true; targetExists = false;
            RetryForegroundWithAlt(currentTarget, heldModifier, sendWake, activate);
            targetExists = true; modifierHeld = true;
            Assert(!RetryForegroundWithAlt(currentTarget, heldModifier, sendWake, activate));
            Assert(injections == 0 && activations == 0);
            modifierHeld = false;
            Assert(RetryForegroundWithAlt(currentTarget, heldModifier, sendWake, activate));
            Assert(injections == 1 && activations == 1);
            foreach (uint sentCount in new uint[] { 0, 1, 2 }) {
                injections = activations = 0;
                RetryForegroundWithAlt(currentTarget, heldModifier, delegate(Input[] inputs) {
                    injections++;
                    if (injections == 2) Assert(inputs.Length == 1 && inputs[0].Data.Keyboard.Flags == 2 && inputs[0].Data.Keyboard.Extra == focusInputMarker);
                    return sentCount;
                }, activate);
                Assert(injections == (sentCount == 1 ? 2 : 1) && activations == (sentCount == 2 ? 1 : 0));
            }
            injections = activations = 0;
            RetryForegroundWithAlt(currentTarget, heldModifier, delegate(Input[] inputs) {
                injections++; activeFocusRequest = "new-request"; return 2;
            }, activate);
            Assert(injections == 1 && activations == 0);
            activeFocusRequest = "focus-test";
            RetryForegroundWithAlt(currentTarget, heldModifier, delegate(Input[] inputs) {
                injections++; targetVisible = false; return 2;
            }, activate);
            Assert(injections == 2 && activations == 0);
            activeFocusRequest = null;
            // 隐藏的自有 HWND 可在首次展示前准备；不改变输入样式、尺寸或前台窗口。
            int originalIgnoreProcessId = ignoreProcessId;
            ignoreProcessId = Process.GetCurrentProcess().Id;
            IntPtr ownedOverlay = CreateWindowEx(0x08080020, "STATIC", "RabbitBall overlay validation", 0x80000000, 10, 20, 80, 60, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            Assert(ownedOverlay != IntPtr.Zero);
            try {
                uint beforeStyle = GetWindowStyle(ownedOverlay, -20);
                IntPtr beforeForeground = GetForegroundWindow();
                Rect beforeRect, afterRect;
                Assert(GetClientRect(ownedOverlay, out beforeRect));
                Assert(PrepareOverlayWindow(ownedOverlay.ToInt64()));
                Assert(GetWindowStyle(ownedOverlay, -20) == (beforeStyle | 0x80));
                Assert(!IsWindowVisible(ownedOverlay) && GetForegroundWindow() == beforeForeground);
                Assert(GetClientRect(ownedOverlay, out afterRect) && beforeRect.Left == afterRect.Left && beforeRect.Top == afterRect.Top && beforeRect.Right == afterRect.Right && beforeRect.Bottom == afterRect.Bottom);
                Assert(PrepareOverlayWindow(ownedOverlay.ToInt64()));
                uint shellStyle = GetWindowStyle(GetShellWindow(), -20);
                Assert(!PrepareOverlayWindow(GetShellWindow().ToInt64()));
                Assert(GetWindowStyle(GetShellWindow(), -20) == shellStyle);
                Assert(!PrepareOverlayWindow(0));
                ignoreProcessId = 0;
                Assert(!PrepareOverlayWindow(ownedOverlay.ToInt64()));
            } finally {
                DestroyWindow(ownedOverlay);
                ignoreProcessId = originalIgnoreProcessId;
            }
            Assert(!PrepareOverlayWindow(ownedOverlay.ToInt64()));
            string escapedId = "test\n\"\\id";
            Dictionary<string, object> focusJson = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(FocusResultJson(escapedId, true));
            Assert(Object.Equals(focusJson["requestId"], escapedId) && Object.Equals(focusJson["focused"], true));
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            Dictionary<string, object> configJson = serializer.Deserialize<Dictionary<string, object>>("{\"type\":\"configure\",\"requestId\":\"barrier-1\",\"pauseOnFullscreen\":true,\"inputEnabled\":true,\"allowOwnForeground\":true,\"recording\":false,\"shortcuts\":{\"prompt\":[{\"code\":\"F8\",\"key\":66,\"modifier\":false}],\"graph\":[{\"code\":\"AltRight\",\"key\":312,\"modifier\":true}]}}");
            NativeConfig parsed = ParseConfiguration(configJson, serializer);
            Assert(parsed.requestId == "barrier-1" && parsed.shortcuts.prompt.Length == 1 && parsed.shortcuts.prompt[0].key == 66 && parsed.allowOwnForeground && !parsed.recording);
            Assert(parsed.shortcuts.graph.Length == 1 && parsed.shortcuts.graph[0].key == 312);
            Console.Out.WriteLine("{\"type\":\"validated\",\"tests\":" + assertions + "}");
        }
    }
}
'@
    if ($ValidateOnly) {
        [RabbitBall.WindowsNative]::Validate()
    } else {
        [RabbitBall.WindowsNative]::Run($IgnoreProcessId)
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
