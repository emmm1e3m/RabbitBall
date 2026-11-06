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
        const uint WM_QUIT = 0x0012, WM_TIMER = 0x0113, WM_CONFIGURE = 0x8001, WM_CANCEL_CAPTURE = 0x8002;
        const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
        const uint WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
        const uint WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208, WM_MOUSEWHEEL = 0x020A;
        const uint WM_XBUTTONDOWN = 0x020B, WM_XBUTTONUP = 0x020C, WM_MOUSEHWHEEL = 0x020E;
        static readonly UIntPtr OwnMarker = new UIntPtr(0x5242424Cu);

        enum KeyRoute { Passed, Buffered, Consumed }
        sealed class ShortcutMember { public string code; public int key; public bool modifier; }
        sealed class NativeConfig {
            public string requestId;
            public bool pauseOnFullscreen = true;
            public bool inputEnabled;
            public bool allowOwnForeground;
            public bool recording;
            public ShortcutMember[] shortcut = new ShortcutMember[0];
        }
        sealed class Stroke {
            public KeyboardHook Raw;
            public bool Up, IsMouse;
            public int Button;
            public uint MouseFlags, MouseData;
            public int Identity { get { return IsMouse ? 0x1000 + Button : KeyId(Raw); } }
            public static Stroke Key(KeyboardHook raw, bool up) { return new Stroke { Raw = raw, Up = up }; }
            public static Stroke Mouse(int button, bool up, uint flags, uint data) {
                return new Stroke { IsMouse = true, Button = button, Up = up, MouseFlags = flags, MouseData = data };
            }
            public Stroke Release() {
                if (!IsMouse) return Key(Raw, true);
                uint flags = Button == 1 ? 4u : Button == 2 ? 16u : Button == 3 ? 64u : 256u;
                return Mouse(Button, true, flags, MouseData);
            }
        }
        sealed class Decision {
            public bool Suppress, Begin, Hold, End, Cancel, SelectionDown, SelectionUp;
            public readonly List<Stroke> Replay = new List<Stroke>();
        }
        sealed class HeldKey { public KeyboardHook Raw; public long Order; public KeyRoute Route; public bool Seeded; }
        sealed class OwnedStroke { public Stroke Down; public long Order; }

        // 所有物理键只有一份账本，配置变化不会重新解释已经按住的键。
        sealed class TriggerState {
            readonly Dictionary<int, HeldKey> held = new Dictionary<int, HeldKey>();
            readonly Dictionary<int, OwnedStroke> owned = new Dictionary<int, OwnedStroke>();
            readonly HashSet<int> buttons = new HashSet<int>();
            readonly HashSet<int> releasedButtons = new HashSet<int>();
            readonly HashSet<int> activeMembers = new HashSet<int>();
            NativeConfig config = new NativeConfig();
            bool active, blocked, consumedLeftDown, holdEmitted;
            long order, replayOrder, startedAt;
            public NativeConfig Config { get { return config; } }
            bool Armed { get { return config.inputEnabled && !config.recording; } }

            public void SeedKey(KeyboardHook raw) {
                // IME 等虚拟键没有物理扫描码，不能留下永远无法配对释放的启动项。
                if ((raw.Scan & 0xFF) == 0) return;
                held[KeyId(raw)] = new HeldKey { Raw = raw, Order = ++order, Route = KeyRoute.Passed, Seeded = true };
                blocked = true;
            }
            public void SeedButton(int button) { buttons.Add(button); }
            void DrainFinished() { if (held.Count == 0) blocked = false; }
            public void ReleaseSeededKeys(Func<uint, bool> isDown) {
                List<int> released = null;
                foreach (KeyValuePair<int, HeldKey> entry in held) {
                    if (!entry.Value.Seeded || isDown(StartupVirtualKey(entry.Value.Raw))) continue;
                    if (released == null) released = new List<int>();
                    released.Add(entry.Key);
                }
                if (released != null) foreach (int id in released) held.Remove(id);
                DrainFinished();
            }
            void RemoveSeededAliases(KeyboardHook release) {
                uint virtualKey = StartupVirtualKey(release);
                List<int> aliases = new List<int>();
                foreach (KeyValuePair<int, HeldKey> entry in held)
                    if (entry.Value.Seeded && StartupVirtualKey(entry.Value.Raw) == virtualKey) aliases.Add(entry.Key);
                foreach (int id in aliases) held.Remove(id);
            }
            ShortcutMember Member(int id) {
                foreach (ShortcutMember member in config.shortcut) if (member.key == id) return member;
                return null;
            }
            static bool ModifierKey(int id) {
                return id == 0x1D || id == 0x11D || id == 0x38 || id == 0x138 ||
                    id == 0x2A || id == 0x36 || id == 0x15B || id == 0x15C;
            }
            // 显式选择右 Alt 时，AltGr 的系统模拟 Ctrl 归属于同一次按键，但不算物理组合成员。
            bool AltGrPrefix(int id) { return id == 0x21D && Member(0x138) != null; }
            bool HasSwallowed() {
                foreach (HeldKey key in held.Values) if (key.Route != KeyRoute.Passed) return true;
                return false;
            }
            List<HeldKey> Swallowed() {
                List<HeldKey> keys = new List<HeldKey>();
                foreach (HeldKey key in held.Values) if (key.Route != KeyRoute.Passed) keys.Add(key);
                keys.Sort(delegate(HeldKey left, HeldKey right) { return left.Order.CompareTo(right.Order); });
                return keys;
            }
            void ReplayHeld(Decision decision, Stroke current) {
                foreach (HeldKey key in Swallowed()) decision.Replay.Add(Stroke.Key(key.Raw, false));
                decision.Replay.Add(current);
                decision.Suppress = true;
                blocked = true;
            }
            void Cancel(Decision decision) {
                if (active) { active = false; decision.Cancel = true; }
                blocked = held.Count != 0;
            }
            bool Exact() {
                int count = 0;
                foreach (int id in held.Keys) {
                    if (AltGrPrefix(id)) continue;
                    if (Member(id) == null) return false;
                    count++;
                }
                return count == config.shortcut.Length;
            }
            bool ModifierPrefix() {
                foreach (int id in held.Keys) {
                    if (AltGrPrefix(id)) continue;
                    ShortcutMember member = Member(id);
                    if (member == null || !member.modifier) return false;
                }
                return true;
            }
            static bool SameConfig(NativeConfig left, NativeConfig right) {
                if (left.inputEnabled != right.inputEnabled || left.recording != right.recording ||
                    left.pauseOnFullscreen != right.pauseOnFullscreen || left.shortcut.Length != right.shortcut.Length) return false;
                foreach (ShortcutMember member in left.shortcut) {
                    bool found = false;
                    foreach (ShortcutMember other in right.shortcut)
                        if (member.key == other.key && member.modifier == other.modifier) { found = true; break; }
                    if (!found) return false;
                }
                return true;
            }
            public Decision Apply(NativeConfig next) {
                Decision decision = new Decision();
                if (!SameConfig(config, next)) {
                    Cancel(decision);
                    // 配置 barrier 排空旧候选，ACK 后不再把旧前缀注入录制或输入框。
                    foreach (HeldKey key in held.Values)
                        if (key.Route == KeyRoute.Buffered) key.Route = KeyRoute.Consumed;
                    decision.Replay.AddRange(OwnedReleases());
                    blocked = held.Count != 0;
                }
                config = next;
                // 启动前已按住的无关普通键不阻塞新快捷键；真实 down、配置键和修饰键继续配对。
                List<int> irrelevant = null;
                foreach (KeyValuePair<int, HeldKey> entry in held) {
                    if (!entry.Value.Seeded || Member(entry.Key) != null || ModifierKey(entry.Key)) continue;
                    if (irrelevant == null) irrelevant = new List<int>();
                    irrelevant.Add(entry.Key);
                }
                if (irrelevant != null) foreach (int id in irrelevant) held.Remove(id);
                DrainFinished();
                return decision;
            }
            public Decision Key(KeyboardHook raw, bool down, long now, Func<bool> gate) {
                int id = KeyId(raw);
                Decision decision = new Decision();
                HeldKey existing;
                if (!down) {
                    if (!held.TryGetValue(id, out existing)) {
                        owned.Remove(id);
                        RemoveSeededAliases(raw);
                        DrainFinished();
                        return decision;
                    }
                    if (active && activeMembers.Contains(id)) {
                        decision.Hold = Hold(now).Hold;
                        active = false;
                        decision.End = true;
                        blocked = true;
                    }
                    if (existing.Route == KeyRoute.Buffered) ReplayHeld(decision, Stroke.Key(raw, true));
                    else decision.Suppress = existing.Route == KeyRoute.Consumed;
                    held.Remove(id);
                    // 启动快照从 VK 推导 scan，可能不同于数字区/AltGr 的真实 release scan。
                    // 即使 repeat 已建立真实 scan 账目，也要一并清理仅来自启动的别名。
                    RemoveSeededAliases(raw);
                    if (!decision.Suppress) owned.Remove(id);
                    DrainFinished();
                    return decision;
                }
                if (held.TryGetValue(id, out existing)) {
                    decision.Suppress = existing.Route != KeyRoute.Passed;
                    return decision;
                }
                HeldKey current = new HeldKey { Raw = raw, Order = ++order, Route = KeyRoute.Passed };
                held.Add(id, current);
                // 未选右 Alt 时保留 AltGr 输入；明确配置右 Alt 时消费它的完整系统序列。
                bool simulatedAltGr = raw.Scan == 0x21D;
                if (simulatedAltGr && Member(0x138) == null) {
                    Cancel(decision);
                    if (HasSwallowed()) ReplayHeld(decision, Stroke.Key(raw, false));
                    blocked = true;
                    return decision;
                }
                if (active) {
                    Cancel(decision);
                    if (id == 1) {
                        // 已进入捕获后的 Escape 只取消本次，不回放成 Alt+Esc 等系统组合。
                        current.Route = KeyRoute.Consumed;
                        decision.Suppress = true;
                        return decision;
                    }
                    ReplayHeld(decision, Stroke.Key(raw, false));
                    return decision;
                }
                if (!Armed) { blocked = true; return decision; }
                ShortcutMember member = Member(simulatedAltGr ? 0x138 : id);
                bool exact = Exact();
                bool candidate = !blocked && member != null &&
                    (member.modifier ? ModifierPrefix() : exact);
                if (candidate && gate()) {
                    current.Route = KeyRoute.Buffered;
                    decision.Suppress = true;
                    if (exact) {
                        foreach (HeldKey key in held.Values) key.Route = KeyRoute.Consumed;
                        activeMembers.Clear();
                        foreach (int key in held.Keys) if (!AltGrPrefix(key)) activeMembers.Add(key);
                        active = true;
                        holdEmitted = false;
                        startedAt = now;
                        decision.Begin = true;
                    }
                    return decision;
                }
                if (HasSwallowed()) ReplayHeld(decision, Stroke.Key(raw, false));
                blocked = true;
                return decision;
            }
            public Decision Mouse(int button, bool down, bool wheel, long now, uint flags, uint data) {
                if (button != 0) { if (down) buttons.Add(button); else buttons.Remove(button); }
                Decision decision = new Decision();
                if (button == 1 && !down && consumedLeftDown) {
                    consumedLeftDown = false;
                    decision.Suppress = true;
                    decision.SelectionUp = active;
                    DrainFinished();
                    return decision;
                }
                if (button != 0 && !down && releasedButtons.Remove(button)) {
                    decision.Suppress = true;
                    DrainFinished();
                    return decision;
                }
                if (button != 0 && !down) owned.Remove(0x1000 + button);
                if (button == 1 && down && active) {
                    decision.Hold = Hold(now).Hold;
                    if (holdEmitted) {
                        consumedLeftDown = true;
                        decision.Suppress = decision.SelectionDown = true;
                        return decision;
                    }
                }
                // 完整触发已拥有按键，鼠标不再撤销或回放它；未完成的修饰前缀仍保留原鼠标组合。
                if ((down || wheel) && Armed && !active && HasSwallowed()) {
                    Cancel(decision);
                    ReplayHeld(decision, Stroke.Mouse(button, false, flags, data));
                }
                DrainFinished();
                return decision;
            }
            public Decision Hold(long now) {
                Decision decision = new Decision();
                if (active && !holdEmitted && now - startedAt >= 500) {
                    holdEmitted = true;
                    decision.Hold = true;
                }
                return decision;
            }
            public Decision CancelCapture() { Decision decision = new Decision(); Cancel(decision); return decision; }
            public void CommitReplay(List<Stroke> replay, uint inserted) {
                int count = Math.Min(replay.Count, (int)inserted);
                for (int index = 0; index < count; index++) {
                    Stroke stroke = replay[index];
                    if (stroke.IsMouse && stroke.Button == 0) continue;
                    int id = stroke.Identity;
                    HeldKey key;
                    if (stroke.Up) {
                        owned.Remove(id);
                        if (!stroke.IsMouse && held.TryGetValue(id, out key)) key.Route = KeyRoute.Consumed;
                        if (stroke.IsMouse && buttons.Contains(stroke.Button)) releasedButtons.Add(stroke.Button);
                    } else {
                        owned[id] = new OwnedStroke { Down = stroke, Order = ++replayOrder };
                        if (!stroke.IsMouse && held.TryGetValue(id, out key)) key.Route = KeyRoute.Passed;
                    }
                }
            }
            public List<Stroke> OwnedReleases() {
                List<OwnedStroke> values = new List<OwnedStroke>(owned.Values);
                values.Sort(delegate(OwnedStroke left, OwnedStroke right) { return right.Order.CompareTo(left.Order); });
                List<Stroke> release = new List<Stroke>();
                foreach (OwnedStroke value in values) release.Add(value.Down.Release());
                return release;
            }
        }
        [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public uint Size; public Rect Monitor, Work; public uint Flags; }
        [StructLayout(LayoutKind.Sequential)] struct KeyboardHook { public uint Key, Scan, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct MouseHook { public Point Point; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Explicit)] struct InputUnion {
            [FieldOffset(0)] public KeyboardInput Keyboard;
            [FieldOffset(0)] public MouseInput Mouse;
        }
        [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputUnion Value; }
        [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Point; public uint Private; }
        delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);

        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int kind, HookProc callback, IntPtr module, uint thread);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
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
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int required);
        [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
        [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern uint GetWindowStyle(IntPtr window, int index);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

        static TriggerState state;
        static IntPtr keyboardHook, mouseHook;
        static HookProc keyboardCallback, mouseCallback;
        static readonly ConcurrentQueue<NativeConfig> pendingConfigurations = new ConcurrentQueue<NativeConfig>();
        static uint hookThread;
        static int ignoreProcessId, ownIntegrity, captureId;
        static readonly Stopwatch clock = Stopwatch.StartNew();
        static UIntPtr holdTimer;
        static int holdCaptureId;
        static bool? previousFullscreen;
        static volatile string failure;
        static volatile string activeFocusRequest;
        static BlockingCollection<string> output;

        static void Emit(string json) { output.Add(json); }

        static void StopHoldTimer() {
            if (holdTimer != UIntPtr.Zero) {
                KillTimer(IntPtr.Zero, holdTimer);
                holdTimer = UIntPtr.Zero;
            }
        }

        static void EmitTrigger(Decision decision) {
            if (decision.Begin) {
                captureId++;
                StopHoldTimer();
                holdCaptureId = captureId;
                holdTimer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 500, IntPtr.Zero);
                if (holdTimer == UIntPtr.Zero) {
                    failure = "无法启动长按检测。";
                    PostThreadMessage(hookThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
                }
                Emit("{\"type\":\"trigger-begin\",\"captureId\":" + captureId + "}");
            }
            if (decision.Hold) {
                StopHoldTimer();
                Emit("{\"type\":\"trigger-hold\",\"captureId\":" + captureId + "}");
            }
            if (decision.End) { StopHoldTimer(); Emit("{\"type\":\"trigger-end\",\"captureId\":" + captureId + "}"); }
            if (decision.Cancel) { StopHoldTimer(); Emit("{\"type\":\"trigger-cancel\",\"captureId\":" + captureId + "}"); }
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

        static bool FocusOwnedWindow(string requestId, long handle) {
            Message message;
            PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
            if (!CurrentFocusRequest(requestId)) return false;
            IntPtr target = new IntPtr(handle);
            uint owner;
            uint targetThread = GetWindowThreadProcessId(target, out owner);
            if (targetThread == 0 || !OwnsVisibleTarget(ignoreProcessId, owner, IsWindow(target), IsWindowVisible(target))) return false;

            if (!CurrentFocusRequest(requestId)) return false;
            if (GetForegroundWindow() == target) return true;
            SetForegroundWindow(target);
            if (GetForegroundWindow() == target) return true;

            uint foregroundOwner;
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundOwner);
            uint workerThread = GetCurrentThreadId();
            bool attachedForeground = false, attachedTarget = false;
            try {
                if (!CurrentFocusRequest(requestId)) return false;
                if (foregroundThread != 0 && foregroundThread != workerThread)
                    attachedForeground = AttachThreadInput(workerThread, foregroundThread, true);
                if (!CurrentFocusRequest(requestId)) return false;
                if (targetThread != workerThread && targetThread != foregroundThread)
                    attachedTarget = AttachThreadInput(workerThread, targetThread, true);
                if (!CurrentFocusRequest(requestId)) return false;
                BringWindowToTop(target);
                if (!CurrentFocusRequest(requestId)) return false;
                SetForegroundWindow(target);
                if (!CurrentFocusRequest(requestId)) return false;
                SetFocus(target);
            } finally {
                // 仅拆开本次确实建立的输入队列关联，且不在全局 hook 线程执行。
                if (attachedTarget) AttachThreadInput(workerThread, targetThread, false);
                if (attachedForeground) AttachThreadInput(workerThread, foregroundThread, false);
            }
            return GetForegroundWindow() == target;
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

        static Input StrokeInput(Stroke stroke) {
            Input input = new Input();
            if (stroke.IsMouse) {
                input.Type = 0;
                input.Value.Mouse.Flags = stroke.MouseFlags;
                input.Value.Mouse.Data = stroke.MouseData;
                input.Value.Mouse.Extra = OwnMarker;
            } else {
                input.Type = 1;
                input.Value.Keyboard.Scan = (ushort)(stroke.Raw.Scan & 0xFF);
                input.Value.Keyboard.Flags = 8u | ((stroke.Raw.Flags & 1) != 0 ? 1u : 0u) | (stroke.Up ? 2u : 0u);
                if (input.Value.Keyboard.Scan == 0) {
                    input.Value.Keyboard.Key = (ushort)stroke.Raw.Key;
                    input.Value.Keyboard.Flags &= ~8u;
                }
                input.Value.Keyboard.Extra = OwnMarker;
            }
            return input;
        }

        static bool ExecuteReplay(Decision decision) {
            if (decision.Replay.Count == 0) return true;
            Input[] inputs = new Input[decision.Replay.Count];
            for (int index = 0; index < inputs.Length; index++) inputs[index] = StrokeInput(decision.Replay[index]);
            uint inserted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
            state.CommitReplay(decision.Replay, inserted);
            if (inserted != inputs.Length) {
                failure = "组合输入回放失败，快捷键监听已停止。";
                PostThreadMessage(hookThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
                return false;
            }
            return true;
        }

        static bool CanStartTrigger() {
            IntPtr foreground = GetForegroundWindow();
            uint foregroundOwner;
            if (GetWindowThreadProcessId(foreground, out foregroundOwner) == 0) return false;
            if (ignoreProcessId > 0 && foregroundOwner == (uint)ignoreProcessId)
                return state.Config.allowOwnForeground;
            if (state.Config.pauseOnFullscreen && ReadFullscreen(foreground) == true) return false;
            return CanInjectForeground(foregroundOwner);
        }

        static bool KeyIsDown(uint key) { return GetAsyncKeyState((int)key) < 0; }

        static IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
            if (code < 0) return CallNextHookEx(keyboardHook, code, message, data);
            KeyboardHook key = (KeyboardHook)Marshal.PtrToStructure(data, typeof(KeyboardHook));
            if (key.Extra == OwnMarker) return CallNextHookEx(keyboardHook, code, message, data);
            uint kind = unchecked((uint)message.ToInt64());
            if (kind != WM_KEYDOWN && kind != WM_SYSKEYDOWN && kind != WM_KEYUP && kind != WM_SYSKEYUP)
                return CallNextHookEx(keyboardHook, code, message, data);
            bool down = kind == WM_KEYDOWN || kind == WM_SYSKEYDOWN;
            // 仅启动快照可用系统状态纠偏，运行期 held 仍严格由 hook 的 down/up 配对。
            state.ReleaseSeededKeys(KeyIsDown);
            Decision decision = state.Key(key, down, clock.ElapsedMilliseconds, CanStartTrigger);
            EmitTrigger(decision);
            ExecuteReplay(decision);
            return decision.Suppress ? new IntPtr(1) : CallNextHookEx(keyboardHook, code, message, data);
        }

        static IntPtr Mouse(int code, IntPtr message, IntPtr data) {
            if (code < 0) return CallNextHookEx(mouseHook, code, message, data);
            MouseHook mouse = (MouseHook)Marshal.PtrToStructure(data, typeof(MouseHook));
            if (mouse.Extra == OwnMarker) return CallNextHookEx(mouseHook, code, message, data);
            uint kind = unchecked((uint)message.ToInt64());
            int button = 0;
            bool down = false;
            uint flags = 0, mouseData = 0;
            if (kind == WM_LBUTTONDOWN || kind == WM_LBUTTONUP) { button = 1; down = kind == WM_LBUTTONDOWN; flags = down ? 2u : 4u; }
            if (kind == WM_RBUTTONDOWN || kind == WM_RBUTTONUP) { button = 2; down = kind == WM_RBUTTONDOWN; flags = down ? 8u : 16u; }
            if (kind == WM_MBUTTONDOWN || kind == WM_MBUTTONUP) { button = 3; down = kind == WM_MBUTTONDOWN; flags = down ? 32u : 64u; }
            if (kind == WM_XBUTTONDOWN || kind == WM_XBUTTONUP) {
                mouseData = mouse.Data >> 16;
                button = 3 + (int)mouseData;
                down = kind == WM_XBUTTONDOWN;
                flags = down ? 128u : 256u;
            }
            bool wheel = kind == WM_MOUSEWHEEL || kind == WM_MOUSEHWHEEL;
            if (wheel) { flags = kind == WM_MOUSEWHEEL ? 0x0800u : 0x1000u; mouseData = unchecked((uint)(int)(short)(mouse.Data >> 16)); }
            state.ReleaseSeededKeys(KeyIsDown);
            Decision decision = state.Mouse(button, down, wheel, clock.ElapsedMilliseconds, flags, mouseData);
            EmitTrigger(decision);
            if (decision.SelectionDown || decision.SelectionUp) {
                string phase = decision.SelectionDown ? "down" : "up";
                Emit("{\"type\":\"selection-pointer\",\"captureId\":" + captureId + ",\"phase\":\"" + phase + "\",\"x\":" + mouse.Point.X + ",\"y\":" + mouse.Point.Y + "}");
            } else if (down && !decision.Suppress) Emit("{\"type\":\"pointer-down\"}");
            ExecuteReplay(decision);
            return decision.Suppress ? new IntPtr(1) : CallNextHookEx(mouseHook, code, message, data);
        }
        static int ReadIntegrity(IntPtr process) {
            IntPtr token;
            if (!OpenProcessToken(process, 8, out token)) return -1;
            IntPtr buffer = IntPtr.Zero;
            try {
                int length;
                GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
                if (length <= 0) return -1;
                buffer = Marshal.AllocHGlobal(length);
                if (!GetTokenInformation(token, 25, buffer, length, out length)) return -1;
                IntPtr sid = Marshal.ReadIntPtr(buffer);
                byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                return count == 0 ? -1 : Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1));
            } finally {
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
                CloseHandle(token);
            }
        }

        static bool CanInjectForeground(uint processId) {
            // UIPI 禁止向更高权限进程回放：提前完整旁路，保留其 Alt 组合键。
            IntPtr process = OpenProcess(0x1000, false, processId);
            if (process == IntPtr.Zero) return false;
            try { int level = ReadIntegrity(process); return level >= 0 && level <= ownIntegrity; }
            finally { CloseHandle(process); }
        }

        static bool? ReadFullscreen(IntPtr window) {
            if (window == IntPtr.Zero || !IsWindow(window) || IsIconic(window)) return false;
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

        static NativeConfig ParseConfiguration(Dictionary<string, object> command, JavaScriptSerializer serializer) {
            object request, pause, enabled, ownForeground, recording, shortcut;
            if (!command.TryGetValue("requestId", out request) || !(request is string) || !ValidRequestId((string)request) ||
                !command.TryGetValue("pauseOnFullscreen", out pause) || !(pause is bool) ||
                !command.TryGetValue("inputEnabled", out enabled) || !(enabled is bool) ||
                !command.TryGetValue("allowOwnForeground", out ownForeground) || !(ownForeground is bool) ||
                !command.TryGetValue("recording", out recording) || !(recording is bool) ||
                !command.TryGetValue("shortcut", out shortcut)) throw new InvalidOperationException("原生助手配置格式无效。");
            NativeConfig config = new NativeConfig { requestId = (string)request, pauseOnFullscreen = (bool)pause,
                inputEnabled = (bool)enabled, allowOwnForeground = (bool)ownForeground, recording = (bool)recording,
                shortcut = serializer.ConvertToType<ShortcutMember[]>(shortcut) };
            if (config.shortcut == null || config.shortcut.Length < 1 || config.shortcut.Length > 5)
                throw new InvalidOperationException("快捷键配置无效。");
            HashSet<int> ids = new HashSet<int>();
            int ordinary = 0;
            foreach (ShortcutMember member in config.shortcut) {
                if (member == null || String.IsNullOrWhiteSpace(member.code) || member.key <= 0 || member.key > 0x1FF ||
                    (member.key & 0xFF) == 0 || !ids.Add(member.key)) throw new InvalidOperationException("快捷键配置无效。");
                if (!member.modifier) ordinary++;
            }
            if (ordinary > 1) throw new InvalidOperationException("快捷键只能包含一个普通按键。");
            return config;
        }

        static void ApplyConfigurations() {
            NativeConfig next;
            while (pendingConfigurations.TryDequeue(out next)) {
                Decision decision = state.Apply(next);
                EmitTrigger(decision);
                if (!ExecuteReplay(decision)) return;
                PollFullscreen();
                Emit(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                    { "type", "configured" }, { "requestId", next.requestId }
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
            ownIntegrity = ReadIntegrity(GetCurrentProcess());
            if (ownIntegrity < 0) throw new InvalidOperationException("无法读取当前进程权限。");
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
                // 先安装两个 hook 再取快照，避免采样与安装之间的 release 永久丢失。
                for (int key = 8; key <= 254; key++) {
                    if (key == 0x10 || key == 0x11 || key == 0x12) continue;
                    if (GetAsyncKeyState(key) < 0) {
                        uint scan = MapVirtualKey((uint)key, 4);
                        state.SeedKey(new KeyboardHook { Key = (uint)key, Scan = scan & 0xFF,
                            Flags = (scan & 0xFF00) == 0xE000 ? 1u : 0u });
                    }
                }
                int[] mouseKeys = new int[] { 1, 2, 4, 5, 6 };
                for (int index = 0; index < mouseKeys.Length; index++)
                    if (GetAsyncKeyState(mouseKeys[index]) < 0) state.SeedButton(index + 1);
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
                    else if (message.Id == WM_TIMER && message.WParam == timer) PollFullscreen();
                    else { TranslateMessage(ref message); DispatchMessage(ref message); }
                }
                if (result == -1) throw new InvalidOperationException("原生消息循环中断。");
                if (failure != null) throw new InvalidOperationException(failure);
            } finally {
                activeFocusRequest = null;
                StopHoldTimer();
                // 仅配平助手确实注入且尚未释放的按键，物理透传键保持原样。
                Decision release = new Decision();
                release.Replay.AddRange(state.OwnedReleases());
                if (!ExecuteReplay(release)) Console.Error.WriteLine("无法完整回放按键释放，请松开当前按键。");
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
            return new NativeConfig { requestId = "test-config", inputEnabled = true, shortcut = members };
        }
        static TriggerState Configured(params ShortcutMember[] members) {
            TriggerState result = new TriggerState();
            Assert(result.Apply(TestConfig(members)).Replay.Count == 0);
            return result;
        }
        static KeyboardHook Raw(int id, long time = 0, bool injected = false) {
            return new KeyboardHook { Key = (uint)(id & 0xFF), Scan = (uint)(id & 0x2FF),
                Flags = ((id & 0x100) != 0 ? 1u : 0u) | (injected ? 0x10u : 0u), Time = (uint)time };
        }
        static KeyboardHook VirtualRaw(uint key, uint flags = 0x10) { return new KeyboardHook { Key = key, Flags = flags }; }
        static Decision Down(TriggerState state, int id, long time = 0) { return state.Key(Raw(id, time), true, time, delegate { return true; }); }
        static Decision Up(TriggerState state, int id, long time = 0) { return state.Key(Raw(id, time), false, time, delegate { return true; }); }
        static void Commit(TriggerState state, Decision decision) { state.CommitReplay(decision.Replay, (uint)decision.Replay.Count); }
        static Decision Button(TriggerState state, int button, bool down, long time) {
            uint flags = button == 1 ? (down ? 2u : 4u) : button == 2 ? (down ? 8u : 16u) : button == 3 ? (down ? 32u : 64u) : (down ? 128u : 256u);
            return state.Mouse(button, down, false, time, flags, button >= 4 ? (uint)(button - 3) : 0u);
        }
        static void ReplayIs(Decision decision, params int[] identities) {
            Assert(decision.Suppress && decision.Replay.Count == identities.Length);
            for (int index = 0; index < identities.Length; index++) Assert(decision.Replay[index].Identity == identities[index]);
        }

        public static void Validate() {
            // 本入口只运行纯状态机和数据序列化，不安装 hook，也不调用焦点或截图 API。
            TriggerState state;
            Decision decision;
            Rect monitor = new Rect { Left = -1920, Top = -1080, Right = 0, Bottom = 0 };
            Assert(FullscreenSurface(monitor, monitor, 0x80000000u));
            Assert(!FullscreenSurface(monitor, monitor, 0x00CF0000u));
            Assert(!FullscreenSurface(monitor, monitor, 0x00040000u));
            Assert(!FullscreenSurface(new Rect { Left = -1920, Top = -1050, Right = 0, Bottom = 0 }, monitor, 0));
            Assert(!FullscreenSurface(new Rect { Left = -1920, Top = -1080, Right = 0, Bottom = -48 }, monitor, 0));
            Assert(!FullscreenSurface(new Rect(), monitor, 0));
            // 自身窗口的前台许可只决定下一次候选，不取消已消费的按压或重解释其释放。
            state = Configured(Mod(0x38));
            Assert(Down(state, 0x38).Begin);
            NativeConfig ownForeground = TestConfig(Mod(0x38)); ownForeground.allowOwnForeground = true;
            Assert(!state.Apply(ownForeground).Cancel && state.Hold(500).Hold && Up(state, 0x38, 501).Suppress);
            // CUA 等系统注入可只给 VK，零扫描码的 down/up 必须与真实物理事件配对。
            foreach (int[] entry in new int[][] {
                new int[] { 0x12, 0x30, 0x38, 1 }, new int[] { 0xA4, 0x10, 0x38, 1 },
                new int[] { 0x12, 0x31, 0x138, 1 }, new int[] { 0xA5, 0x10, 0x138, 1 },
                new int[] { 0x11, 0x10, 0x1D, 1 }, new int[] { 0xA3, 0x10, 0x11D, 1 },
                new int[] { 0x4B, 0x10, 0x25, 0 }, new int[] { 0x77, 0x10, 0x42, 0 },
                new int[] { 0x0D, 0x10, 0x1C, 0 }, new int[] { 0x0D, 0x11, 0x11C, 0 },
                new int[] { 0x2E, 0x11, 0x153, 0 } }) {
                KeyboardHook virtualKey = VirtualRaw((uint)entry[0], (uint)entry[1]);
                Assert(KeyId(virtualKey) == entry[2]);
                state = Configured(entry[3] == 1 ? Mod(entry[2]) : MainKey(entry[2]));
                decision = state.Key(virtualKey, true, 0, delegate { return true; });
                Assert(decision.Begin && decision.Suppress);
                Assert(Up(state, entry[2], 1).End);
                Assert(Down(state, entry[2], 2).Begin);
                virtualKey.Flags |= 0x80;
                decision = state.Key(virtualKey, false, 3, delegate { return true; });
                Assert(decision.End && decision.Suppress && state.OwnedReleases().Count == 0);
            }
            state = Configured(Mod(0x1D), MainKey(0x25));
            decision = state.Key(VirtualRaw(0x11), true, 0, delegate { return true; });
            Assert(decision.Suppress && !decision.Begin);
            decision = state.Key(VirtualRaw(0x4B), true, 1, delegate { return true; });
            Assert(decision.Suppress && decision.Begin);
            Assert(state.Key(VirtualRaw(0x4B, 0x90), false, 2, delegate { return true; }).End);
            Assert(state.Key(VirtualRaw(0x11, 0x90), false, 3, delegate { return true; }).Suppress);
            Assert(state.OwnedReleases().Count == 0);
            // 单 modifier、字母、功能键及普通外部注入都走相同触发路径。
            foreach (int id in new int[] { 0x38, 0x15B, 0x138, 0x1D, 0x11D, 0x2A, 0x36, 0x25, 0x42, 0x1C }) {
                bool modifier = id != 0x25 && id != 0x42 && id != 0x1C;
                state = Configured(modifier ? Mod(id) : MainKey(id));
                decision = Down(state, id, 1000);
                Assert(decision.Begin && decision.Suppress && decision.Replay.Count == 0);
                decision = Down(state, id, 1400);
                Assert(decision.Suppress && !decision.Begin);
                Assert(!state.Hold(1499).Hold && state.Hold(1500).Hold && !state.Hold(1501).Hold);
                decision = Up(state, id, 1502);
                Assert(decision.End && decision.Suppress && !decision.Hold && decision.Replay.Count == 0);
                Assert(!Up(state, id, 1503).End && state.OwnedReleases().Count == 0);
                Assert(Down(state, id, 2000).Begin);
                decision = Up(state, id, 2499);
                Assert(decision.End && !decision.Hold);
                Assert(Down(state, id, 3000).Begin);
                decision = Up(state, id, 3500);
                Assert(decision.End && decision.Hold);
            }
            state = Configured(MainKey(0x42));
            Assert(state.Key(Raw(0x42, 0, true), true, 0, delegate { return true; }).Begin);
            Assert(Up(state, 0x42, 1).End);
            state = Configured(Mod(0x38));
            Assert(Down(state, 0x38).Begin);
            decision = Down(state, 1, 1);
            Assert(decision.Cancel && decision.Suppress && decision.Replay.Count == 0);
            Assert(Up(state, 1, 2).Suppress && Up(state, 0x38, 3).Suppress && state.OwnedReleases().Count == 0);
            state = Configured(Mod(0x38), MainKey(0x25));
            Down(state, 0x38);
            decision = Down(state, 1, 1);
            ReplayIs(decision, 0x38, 1);
            Assert(!decision.Cancel && !decision.Begin);
            // 正序 Ctrl+K，逆序不补触发，普通重复也不能重复 Begin。
            state = Configured(Mod(0x1D), MainKey(0x25));
            decision = Down(state, 0x1D);
            Assert(decision.Suppress && !decision.Begin && decision.Replay.Count == 0);
            Assert(!Down(state, 0x1D, 100).Begin);
            Assert(Down(state, 0x25, 200).Begin);
            Assert(!Down(state, 0x25, 400).Begin);
            Assert(!state.Hold(699).Hold && state.Hold(700).Hold);
            decision = Up(state, 0x25, 701);
            Assert(decision.End && decision.Suppress && decision.Replay.Count == 0);
            decision = Down(state, 0x2E, 702);
            ReplayIs(decision, 0x1D, 0x2E);
            Assert(!decision.Begin && !decision.Cancel);
            Commit(state, decision);
            Assert(!Up(state, 0x2E, 703).Suppress && !Up(state, 0x1D, 704).Suppress);
            Assert(state.OwnedReleases().Count == 0);
            state = Configured(Mod(0x1D), MainKey(0x25));
            Assert(!Down(state, 0x25).Suppress);
            Assert(!Down(state, 0x1D, 1).Begin && !Down(state, 0x25, 2).Begin);
            Assert(!Up(state, 0x1D, 3).Suppress && !Up(state, 0x25, 4).Suppress);
            Assert(Down(state, 0x1D, 5).Suppress && Down(state, 0x25, 6).Begin);
            // 任意成员松开只 End 一次，剩余成员保持吞键到配对 up。
            foreach (bool primaryFirst in new bool[] { true, false }) {
                state = Configured(Mod(0x1D), MainKey(0x25));
                Down(state, 0x1D); Down(state, 0x25, 1);
                Assert(Up(state, primaryFirst ? 0x25 : 0x1D, 10).End);
                decision = Up(state, primaryFirst ? 0x1D : 0x25, 11);
                Assert(decision.Suppress && !decision.End && decision.Replay.Count == 0);
            }
            // 全 modifier 可以按任一顺序完成，额外键会使 exact 集合不成立。
            foreach (bool reverse in new bool[] { true, false }) {
                state = Configured(Mod(0x1D), Mod(0x2A));
                Assert(!Down(state, reverse ? 0x2A : 0x1D).Begin);
                Assert(Down(state, reverse ? 0x1D : 0x2A, 1).Begin);
                Assert(Up(state, 0x1D, 2).End && !Up(state, 0x2A, 3).End);
            }
            state = Configured(Mod(0x1D), MainKey(0x25));
            Assert(!Down(state, 0x2E).Suppress);
            Assert(!Down(state, 0x1D, 1).Begin && !Down(state, 0x25, 2).Begin);
            // Alt/Win 未完成的前缀以 down+up 恢复原系统菜单；已完成捕获不泄漏裸菜单。
            foreach (int modifier in new int[] { 0x38, 0x15B }) {
                state = Configured(Mod(modifier), MainKey(0x25));
                Assert(Down(state, modifier).Suppress);
                decision = Up(state, modifier, 1);
                ReplayIs(decision, modifier, modifier);
                Assert(!decision.Replay[0].Up && decision.Replay[1].Up);
                Commit(state, decision);
                Assert(state.OwnedReleases().Count == 0);
                Down(state, modifier, 2);
                Assert(Down(state, 0x25, 3).Begin);
                Assert(Up(state, 0x25, 4).End);
                Assert(Up(state, modifier, 5).Replay.Count == 0);
            }
            // 非匹配 Ctrl+C 与 Ctrl+wheel 只回放仍 held 前缀，不重复已透传 down。
            state = Configured(Mod(0x1D), MainKey(0x25));
            Down(state, 0x1D);
            decision = Down(state, 0x2E, 1);
            ReplayIs(decision, 0x1D, 0x2E);
            Commit(state, decision);
            Assert(Down(state, 0x2E, 2).Replay.Count == 0);
            Assert(!Up(state, 0x2E, 3).Suppress && !Up(state, 0x1D, 4).Suppress);
            state = Configured(Mod(0x1D), MainKey(0x25));
            Down(state, 0x1D);
            decision = state.Mouse(0, false, true, 1, 0x800, unchecked((uint)-120));
            ReplayIs(decision, 0x1D, 0x1000);
            Assert(decision.Replay[1].IsMouse && decision.Replay[1].MouseData == unchecked((uint)-120));
            Commit(state, decision);
            Assert(state.OwnedReleases().Count == 1);
            Assert(!Up(state, 0x1D, 2).Suppress && state.OwnedReleases().Count == 0);
            state = new TriggerState();
            state.SeedKey(Raw(0x1D));
            state.Apply(TestConfig(Mod(0x1D), MainKey(0x25)));
            Assert(!Down(state, 0x25).Begin && Down(state, 0x2E, 1).Replay.Count == 0);
            // 无扫描码的 IME 启动快照不能让所有快捷键永久 blocked。
            state = new TriggerState();
            KeyboardHook processKey = Raw(0); processKey.Key = 0xE5;
            state.SeedKey(processKey);
            state.Apply(TestConfig(Mod(0x38)));
            Assert(Down(state, 0x38).Begin && Up(state, 0x38, 1).End);
            // 快照后丢失的 release 只清理 Seeded；仍按住的快照项继续等待真实释放。
            foreach (bool stillDown in new bool[] { false, true }) {
                state = new TriggerState();
                KeyboardHook seeded = Raw(0x1D); seeded.Key = 0xA2;
                state.SeedKey(seeded);
                state.Apply(TestConfig(Mod(0x38)));
                int queries = 0;
                state.ReleaseSeededKeys(delegate(uint key) { queries++; Assert(key == 0xA2); return stillDown; });
                Assert(queries == 1);
                Assert(Down(state, 0x38).Begin == !stillDown);
                Up(state, 0x38, 1);
                state.ReleaseSeededKeys(delegate(uint key) { return false; });
                Assert(Down(state, 0x38, 2).Begin && Up(state, 0x38, 3).End);
            }
            // 纠偏不能查询或删除运行期真实按键；鼠标按住不构成触发阻塞。
            state = Configured(Mod(0x38));
            Down(state, 0x1D);
            int runtimeQueries = 0;
            state.ReleaseSeededKeys(delegate(uint key) { runtimeQueries++; return false; });
            Assert(runtimeQueries == 0 && !Down(state, 0x38, 1).Begin);
            Up(state, 0x38, 2); Up(state, 0x1D, 3);
            Assert(Down(state, 0x38, 4).Begin);
            state.ReleaseSeededKeys(delegate(uint key) { runtimeQueries++; return false; });
            Assert(runtimeQueries == 0 && state.Hold(504).Hold && Up(state, 0x38, 505).End);
            state = Configured(Mod(0x38));
            state.SeedButton(1);
            state.ReleaseSeededKeys(delegate(uint key) { return false; });
            Assert(Down(state, 0x38).Begin);
            Up(state, 0x38, 1); Button(state, 1, false, 2);
            Assert(Down(state, 0x38, 3).Begin);
            // 启动时无关普通键即使一直按住，也不能永久禁用全部快捷键。
            state = new TriggerState();
            KeyboardHook seededF22 = Raw(0x6D); seededF22.Key = 0x85;
            state.SeedKey(seededF22);
            state.Apply(TestConfig(Mod(0x38)));
            Assert(Down(state, 0x38).Begin && Up(state, 0x38, 1).End);
            // 同一启动键若被配置为快捷键，已有按压和重复事件不能误触发。
            state = new TriggerState();
            state.SeedKey(seededF22);
            state.Apply(TestConfig(MainKey(0x6D)));
            Assert(!Down(state, 0x6D).Begin && !Up(state, 0x6D, 1).Suppress);
            Assert(Down(state, 0x6D, 2).Begin && Up(state, 0x6D, 3).End);
            // 未配置的启动修饰键仍阻止匹配，释放后才能激活。
            state = new TriggerState();
            KeyboardHook seededModifier = Raw(0x1D); seededModifier.Key = 0xA2;
            state.SeedKey(seededModifier);
            state.Apply(TestConfig(Mod(0x38)));
            Assert(!Down(state, 0x38).Begin);
            Up(state, 0x38, 1); Up(state, 0x1D, 2);
            Assert(Down(state, 0x38, 3).Begin && Up(state, 0x38, 4).End);
            // hook 已收到的真实额外普通键不能被配置更新顺带删掉。
            state = Configured(Mod(0x38));
            Assert(!Down(state, 0x6D).Suppress);
            state.Apply(TestConfig(Mod(0x38)));
            Assert(!Down(state, 0x38, 1).Begin);
            Up(state, 0x38, 2); Up(state, 0x6D, 3);
            Assert(Down(state, 0x38, 4).Begin && Up(state, 0x38, 5).End);
            // 启动时 AltGr fake Ctrl、NumLock 关闭的数字区键不能留下错误 scan 种子。
            foreach (bool repeat in new bool[] { false, true }) {
                state = new TriggerState();
                KeyboardHook seededCtrl = Raw(0x1D); seededCtrl.Key = 0xA2;
                KeyboardHook actualFakeCtrl = Raw(0x21D, 1, true); actualFakeCtrl.Key = 0x11;
                state.SeedKey(seededCtrl);
                state.Apply(TestConfig(MainKey(0x42)));
                if (repeat) state.Key(actualFakeCtrl, true, 1, delegate { return true; });
                decision = state.Key(actualFakeCtrl, false, 2, delegate { return true; });
                Assert(!decision.Suppress && decision.Replay.Count == 0);
                Assert(Down(state, 0x42, 3).Begin);
                state = new TriggerState();
                KeyboardHook seededEnd = Raw(0x14F); seededEnd.Key = 0x23;
                KeyboardHook actualNumpadEnd = Raw(0x4F, 1); actualNumpadEnd.Key = 0x23;
                state.SeedKey(seededEnd);
                state.Apply(TestConfig(MainKey(0x42)));
                if (repeat) state.Key(actualNumpadEnd, true, 1, delegate { return true; });
                decision = state.Key(actualNumpadEnd, false, 2, delegate { return true; });
                Assert(!decision.Suppress && decision.Replay.Count == 0);
                Assert(Down(state, 0x42, 3).Begin);
            }
            // 同 VK 的运行期键仍严格按 scan 配对，不能被 seed-only fallback 清除。
            state = Configured(MainKey(0x42));
            KeyboardHook runtimeEnd = Raw(0x14F); runtimeEnd.Key = 0x23;
            KeyboardHook otherEnd = Raw(0x4F); otherEnd.Key = 0x23;
            state.Key(runtimeEnd, true, 0, delegate { return true; });
            state.Key(otherEnd, false, 1, delegate { return true; });
            Assert(!Down(state, 0x42, 2).Begin);
            Up(state, 0x42, 3);
            state.Key(runtimeEnd, false, 4, delegate { return true; });
            Assert(Down(state, 0x42, 5).Begin);
            // 未配置右 Alt 时，AltGr 的模拟 Ctrl 与右 Alt 继续透传给国际布局。
            foreach (ShortcutMember[] shortcut in new ShortcutMember[][] {
                new ShortcutMember[] { Mod(0x1D) }, new ShortcutMember[] { MainKey(0x42) } }) {
                state = Configured(shortcut);
                decision = state.Key(Raw(0x21D, 0, true), true, 0, delegate { return true; });
                Assert(!decision.Suppress && !decision.Begin);
                decision = Down(state, 0x138, 1);
                Assert(!decision.Begin && !decision.Suppress);
                Assert(!Up(state, 0x138, 2).End && !Up(state, 0x21D, 3).End);
            }
            // 显式右 Alt 消费 fake Ctrl、RAlt 的全部 down/up，释放顺序不提前结束触发。
            foreach (bool fakeFirst in new bool[] { false, true }) {
                state = Configured(Mod(0x138));
                decision = Down(state, 0x21D);
                Assert(decision.Suppress && !decision.Begin && decision.Replay.Count == 0);
                Assert(Down(state, 0x138, 1).Begin);
                Assert(Down(state, 0x21D, 2).Suppress && !Down(state, 0x138, 3).Begin);
                Assert(!state.Hold(500).Hold && state.Hold(501).Hold);
                decision = Up(state, fakeFirst ? 0x21D : 0x138, 502);
                Assert(decision.Suppress && decision.End == !fakeFirst && decision.Replay.Count == 0);
                decision = Up(state, fakeFirst ? 0x138 : 0x21D, 503);
                Assert(decision.Suppress && decision.End == fakeFirst && decision.Replay.Count == 0);
                Assert(state.OwnedReleases().Count == 0 && Down(state, 0x138, 504).Begin);
            }
            // 模拟 Ctrl 不能替代配置中的真实 Ctrl；真实 Ctrl+右 Alt 可完整触发。
            state = Configured(Mod(0x1D), Mod(0x138));
            Assert(Down(state, 0x21D).Suppress && !Down(state, 0x138, 1).Begin);
            decision = Up(state, 0x138, 2);
            ReplayIs(decision, 0x21D, 0x138, 0x138); Commit(state, decision);
            Assert(!Up(state, 0x21D, 3).Suppress && state.OwnedReleases().Count == 0);
            state = Configured(Mod(0x1D), Mod(0x138));
            Assert(Down(state, 0x1D).Suppress && Down(state, 0x21D, 1).Suppress);
            Assert(Down(state, 0x138, 2).Begin);
            Assert(Up(state, 0x138, 3).End && Up(state, 0x21D, 4).Suppress && Up(state, 0x1D, 5).Suppress);
            state = Configured(Mod(0x138), MainKey(0x25));
            Assert(Down(state, 0x21D).Suppress && Down(state, 0x138, 1).Suppress);
            Assert(Down(state, 0x25, 2).Begin && Up(state, 0x21D, 3).Suppress);
            Assert(Up(state, 0x25, 4).End && Up(state, 0x138, 5).Suppress);
            // 右 Alt 组合未完成或改按其他键时，按原顺序回放，不能留下吞掉的 Ctrl。
            state = Configured(Mod(0x138), MainKey(0x25));
            Down(state, 0x21D); Down(state, 0x138, 1);
            decision = Down(state, 0x2E, 2);
            ReplayIs(decision, 0x21D, 0x138, 0x2E); Commit(state, decision);
            Assert(!Up(state, 0x2E, 3).Suppress && !Up(state, 0x138, 4).Suppress && !Up(state, 0x21D, 5).Suppress);
            Assert(state.OwnedReleases().Count == 0);
            // 自有输入框、录制与暂停仍旁路，不因配置右 Alt 而吞掉国际布局输入。
            foreach (bool recordingMode in new bool[] { false, true }) {
                state = new TriggerState();
                NativeConfig bypass = TestConfig(Mod(0x138)); bypass.recording = recordingMode; bypass.inputEnabled = recordingMode;
                state.Apply(bypass);
                Assert(!Down(state, 0x21D).Suppress && !Down(state, 0x138, 1).Begin);
                Assert(!Up(state, 0x138, 2).Suppress && !Up(state, 0x21D, 3).Suppress);
            }
            state = Configured(Mod(0x138));
            Assert(!state.Key(Raw(0x21D), true, 0, delegate { return false; }).Suppress);
            Assert(!Down(state, 0x138, 1).Begin);
            Assert(KeyId(Raw(0x21D)) == 0x21D && KeyId(Raw(0x1D)) == 0x1D && KeyId(Raw(0x138)) == 0x138);
            // 只有真正候选才调用环境 gate：UIPI、全屏或自身前台均不吞新 candidate。
            int gateCalls = 0;
            state = Configured(MainKey(0x42));
            decision = state.Key(Raw(0x2E), true, 0, delegate { gateCalls++; return false; });
            Assert(!decision.Suppress && gateCalls == 0);
            Up(state, 0x2E, 1);
            foreach (string denied in new string[] { "uipi", "fullscreen", "own-window" }) {
                decision = state.Key(Raw(0x42), true, 2, delegate { gateCalls++; return false; });
                Assert(!decision.Begin && !decision.Suppress);
                Up(state, 0x42, 3);
            }
            Assert(gateCalls == 3);
            state = Configured(Mod(0x1D), MainKey(0x25));
            Down(state, 0x1D);
            decision = state.Key(Raw(0x25), true, 1, delegate { return false; });
            ReplayIs(decision, 0x1D, 0x25);
            Assert(!decision.Begin);
            // 短按、499/500/501、重复、旧 timer 以及连续左键多选。
            foreach (long elapsed in new long[] { 499, 500, 501 }) {
                state = Configured(Mod(0x38));
                Assert(Down(state, 0x38).Begin);
                decision = Button(state, 1, true, elapsed);
                if (elapsed < 500) {
                    Assert(!decision.Cancel && !decision.SelectionDown && !decision.Suppress && decision.Replay.Count == 0);
                    Assert(!Button(state, 1, false, elapsed + 1).Suppress);
                    Assert(Up(state, 0x38, elapsed + 2).Suppress);
                } else {
                    Assert(decision.Hold && decision.SelectionDown && decision.Suppress && decision.Replay.Count == 0);
                    Assert(Button(state, 1, false, elapsed + 1).SelectionUp);
                    for (int index = 0; index < 3; index++) {
                        Assert(Button(state, 1, true, elapsed + 2 + index * 2).SelectionDown);
                        Assert(Button(state, 1, false, elapsed + 3 + index * 2).SelectionUp);
                    }
                    Assert(Up(state, 0x38, elapsed + 20).End);
                }
                Assert(state.OwnedReleases().Count == 0);
            }
            state = Configured(Mod(0x38));
            Down(state, 0x38);
            Assert(Button(state, 1, true, 500).SelectionDown);
            Assert(Up(state, 0x38, 501).End);
            decision = Button(state, 1, false, 502);
            Assert(decision.Suppress && !decision.SelectionUp);
            Assert(!Button(state, 1, false, 503).Suppress);
            state = Configured(Mod(0x38));
            Down(state, 0x38);
            Assert(state.CancelCapture().Cancel && !state.CancelCapture().Cancel);
            Assert(!state.Hold(501).Hold && Up(state, 0x38, 502).Suppress);
            Assert(Down(state, 0x38, 2000).Begin && !state.Hold(2001).Hold && state.Hold(2500).Hold);
            state = Configured(Mod(0x38));
            state.SeedButton(1);
            Assert(Down(state, 0x38).Begin && !Button(state, 1, false, 1).Suppress);
            Assert(Up(state, 0x38, 2).Suppress);
            // 各鼠标键先按/后按都不阻断完整快捷键，按住鼠标时可重复触发。
            foreach (int button in new int[] { 1, 2, 3, 4, 5 }) {
                state = Configured(Mod(0x38));
                Assert(!Button(state, button, true, 0).Suppress);
                for (int index = 0; index < 3; index++) {
                    Assert(Down(state, 0x38, index * 10 + 1).Begin);
                    decision = Up(state, 0x38, index * 10 + 2);
                    Assert(decision.End && decision.Suppress && decision.Replay.Count == 0);
                }
                Assert(!Button(state, button, false, 40).Suppress);
                Assert(Down(state, 0x38, 50).Begin);
                decision = Button(state, button, true, 51);
                Assert(!decision.Cancel && decision.Replay.Count == 0);
                Assert(!Button(state, button, false, 52).Suppress);
                Assert(Up(state, 0x38, 53).Suppress);
            }
            state = Configured(Mod(0x38));
            Down(state, 0x38);
            decision = state.Mouse(0, false, true, 1, 0x800, 120);
            Assert(!decision.Cancel && decision.Replay.Count == 0 && !decision.Suppress);
            Assert(Up(state, 0x38, 2).Suppress);
            // 先配置才 armed；配置相同不取消，修改/录制/禁用将旧 held 留在 drain。
            state = new TriggerState();
            Assert(!Down(state, 0x38).Suppress);
            state.Apply(TestConfig(Mod(0x38)));
            Assert(!Down(state, 0x38, 1).Begin && !Up(state, 0x38, 2).Suppress);
            Assert(Down(state, 0x38, 3).Begin);
            decision = state.Apply(TestConfig(Mod(0x38)));
            Assert(!decision.Cancel && decision.Replay.Count == 0);
            Assert(state.Hold(503).Hold);
            NativeConfig changed = TestConfig(MainKey(0x42));
            Assert(state.Apply(changed).Cancel);
            Assert(!Down(state, 0x38, 504).Begin);
            Assert(Up(state, 0x38, 505).Suppress && Down(state, 0x42, 506).Begin);
            state = Configured(Mod(0x38));
            Down(state, 0x38);
            NativeConfig recording = TestConfig(Mod(0x38)); recording.recording = true;
            Assert(state.Apply(recording).Cancel);
            Assert(Down(state, 0x38, 1).Suppress);
            Assert(!Down(state, 0x42, 2).Suppress && !Up(state, 0x42, 3).Suppress);
            state.Apply(TestConfig(Mod(0x38)));
            Assert(!Down(state, 0x38, 4).Begin && Up(state, 0x38, 5).Suppress);
            Assert(Down(state, 0x38, 6).Begin);
            state = Configured(Mod(0x1D), MainKey(0x25));
            Assert(Down(state, 0x1D).Suppress);
            NativeConfig prefixRecording = TestConfig(Mod(0x1D), MainKey(0x25)); prefixRecording.recording = true;
            Assert(state.Apply(prefixRecording).Replay.Count == 0);
            decision = Up(state, 0x1D, 1);
            Assert(decision.Suppress && decision.Replay.Count == 0);
            Assert(!Down(state, 0x42, 2).Suppress && !Up(state, 0x42, 3).Suppress);
            state = Configured(Mod(0x1D), MainKey(0x25));
            Down(state, 0x1D);
            Assert(!state.Apply(TestConfig(Mod(0x1D), MainKey(0x25))).Cancel);
            decision = Up(state, 0x1D, 1);
            ReplayIs(decision, 0x1D, 0x1D);
            state = Configured(Mod(0x38));
            Down(state, 0x38);
            Button(state, 1, true, 500);
            NativeConfig disabled = TestConfig(Mod(0x38)); disabled.inputEnabled = false;
            Assert(state.Apply(disabled).Cancel);
            Assert(Button(state, 1, false, 501).Suppress);
            Assert(!Button(state, 1, true, 502).Suppress && !Button(state, 1, false, 503).Suppress);
            Assert(Up(state, 0x38, 504).Suppress);
            Assert(!Down(state, 0x38, 505).Suppress && !Up(state, 0x38, 506).Suppress);
            // 配置切换和退出只配平真实插入的 down，partial insert 也保留精确所有权。
            foreach (uint inserted in new uint[] { 0, 1, 2 }) {
                state = Configured(Mod(0x1D), MainKey(0x25));
                Down(state, 0x1D);
                decision = Down(state, 0x2E, 1);
                state.CommitReplay(decision.Replay, inserted);
                List<Stroke> release = state.OwnedReleases();
                Assert(release.Count == inserted);
                foreach (Stroke stroke in release) Assert(stroke.Up);
                if (inserted == 2) Assert(release[0].Identity == 0x2E && release[1].Identity == 0x1D);
            }
            state = Configured(Mod(0x1D), MainKey(0x25));
            Down(state, 0x1D);
            decision = Down(state, 0x2E, 1); Commit(state, decision);
            decision = state.Apply(disabled);
            Assert(decision.Replay.Count == 2);
            Commit(state, decision);
            Assert(Up(state, 0x2E, 2).Suppress && Up(state, 0x1D, 3).Suppress && state.OwnedReleases().Count == 0);
            // 扫描码、扩展键、滚轮与 XBUTTON 的 SendInput 数据保持原始物理含义。
            Input input = StrokeInput(Stroke.Key(Raw(0x11D), false));
            Assert(input.Type == 1 && input.Value.Keyboard.Key == 0 && input.Value.Keyboard.Scan == 0x1D && input.Value.Keyboard.Flags == 9);
            Assert(StrokeInput(Stroke.Key(Raw(0x11D), true)).Value.Keyboard.Flags == 11);
            Assert(input.Value.Keyboard.Extra == OwnMarker);
            input = StrokeInput(Stroke.Mouse(0, false, 0x1000, unchecked((uint)-120)));
            Assert(input.Value.Mouse.Data == unchecked((uint)-120) && input.Value.Mouse.Flags == 0x1000);
            Assert(StrokeInput(Stroke.Mouse(5, false, 128, 2)).Value.Mouse.Data == 2);
            Assert(Marshal.SizeOf(typeof(Input)) == (IntPtr.Size == 8 ? 40 : 28));
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
            string escapedId = "test\n\"\\id";
            Dictionary<string, object> focusJson = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(FocusResultJson(escapedId, true));
            Assert(Object.Equals(focusJson["requestId"], escapedId) && Object.Equals(focusJson["focused"], true));
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            Dictionary<string, object> configJson = serializer.Deserialize<Dictionary<string, object>>("{\"type\":\"configure\",\"requestId\":\"barrier-1\",\"pauseOnFullscreen\":true,\"inputEnabled\":true,\"allowOwnForeground\":true,\"recording\":false,\"shortcut\":[{\"code\":\"F8\",\"key\":66,\"modifier\":false}]}");
            NativeConfig parsed = ParseConfiguration(configJson, serializer);
            Assert(parsed.requestId == "barrier-1" && parsed.shortcut.Length == 1 && parsed.shortcut[0].key == 66 && parsed.allowOwnForeground && !parsed.recording);
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
