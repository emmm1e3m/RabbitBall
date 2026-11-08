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
        const uint WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208;
        const uint WM_XBUTTONDOWN = 0x020B, WM_XBUTTONUP = 0x020C;
        sealed class ShortcutMember { public string code; public int key; public bool modifier; }
        sealed class NativeConfig {
            public string requestId;
            public bool pauseOnFullscreen = true;
            public bool inputEnabled;
            public bool allowOwnForeground;
            public bool recording;
            public ShortcutMember[] shortcut = new ShortcutMember[0];
        }
        sealed class Decision { public bool Suppress, Begin, Hold, End, Cancel, SelectionDown, SelectionUp; }
        sealed class HeldKey { public KeyboardHook Raw; public bool Suppress, Eligible, Seeded; }

        // 只记专用键及已吞下的 Escape；每次按压的吞/透传决定保持到释放。
        sealed class TriggerState {
            readonly Dictionary<int, HeldKey> held = new Dictionary<int, HeldKey>();
            NativeConfig config = new NativeConfig();
            bool active, consumedLeftDown, holdEmitted;
            long startedAt;
            public NativeConfig Config { get { return config; } }
            bool Armed { get { return config.inputEnabled && !config.recording; } }
            bool Member(int id) {
                foreach (ShortcutMember member in config.shortcut) if (member.key == id) return true;
                return false;
            }
            bool AltGrPrefix(int id) { return id == 0x21D && Member(0x138); }
            bool Complete() {
                if (config.shortcut.Length == 0) return false;
                foreach (ShortcutMember member in config.shortcut) {
                    HeldKey key;
                    if (!held.TryGetValue(member.key, out key) || !key.Eligible) return false;
                }
                return true;
            }
            void EndCycle() {
                active = false;
                // 组合完成或取消后须松开其成员，不能靠另一个成员的重复按下重入。
                foreach (HeldKey key in held.Values) key.Eligible = false;
            }
            void Cancel(Decision decision) {
                decision.Cancel = active;
                EndCycle();
            }
            static bool SameConfig(NativeConfig left, NativeConfig right) {
                if (left.inputEnabled != right.inputEnabled || left.recording != right.recording ||
                    left.pauseOnFullscreen != right.pauseOnFullscreen || left.shortcut.Length != right.shortcut.Length) return false;
                foreach (ShortcutMember member in left.shortcut) {
                    bool found = false;
                    foreach (ShortcutMember other in right.shortcut) if (member.key == other.key) { found = true; break; }
                    if (!found) return false;
                }
                return true;
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
                    foreach (ShortcutMember member in config.shortcut) {
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
                Decision decision = new Decision();
                HeldKey existing;
                if (!down) {
                    if (held.TryGetValue(id, out existing)) {
                        decision.Suppress = existing.Suppress;
                        if (active && Member(id)) {
                            decision.Hold = Hold(now).Hold;
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
                if (active && id == 1 && !Member(id)) {
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
                if (!active && Complete()) {
                    active = true;
                    holdEmitted = false;
                    startedAt = now;
                    decision.Begin = true;
                }
                return decision;
            }
            public Decision Mouse(int button, bool down, long now) {
                Decision decision = new Decision();
                if (button == 1 && !down && consumedLeftDown) {
                    consumedLeftDown = false;
                    decision.Suppress = true;
                    decision.SelectionUp = active;
                } else if (button == 1 && down && active) {
                    decision.Hold = Hold(now).Hold;
                    if (holdEmitted) {
                        consumedLeftDown = true;
                        decision.Suppress = decision.SelectionDown = true;
                    }
                }
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
        }
        [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public uint Size; public Rect Monitor, Work; public uint Flags; }
        [StructLayout(LayoutKind.Sequential)] struct KeyboardHook { public uint Key, Scan, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] struct MouseHook { public Point Point; public uint Data, Flags, Time; public UIntPtr Extra; }
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
        static int ignoreProcessId, captureId;
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
            uint kind = unchecked((uint)message.ToInt64());
            if (kind != WM_KEYDOWN && kind != WM_SYSKEYDOWN && kind != WM_KEYUP && kind != WM_SYSKEYUP)
                return CallNextHookEx(keyboardHook, code, message, data);
            bool down = kind == WM_KEYDOWN || kind == WM_SYSKEYDOWN;
            // 仅启动快照可用系统状态纠偏，运行期 held 仍严格由 hook 的 down/up 配对。
            state.ReleaseSeededKeys(KeyIsDown);
            Decision decision = state.Key(key, down, clock.ElapsedMilliseconds, CanStartTrigger);
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
            EmitTrigger(decision);
            if (decision.SelectionDown || decision.SelectionUp) {
                string phase = decision.SelectionDown ? "down" : "up";
                Emit("{\"type\":\"selection-pointer\",\"captureId\":" + captureId + ",\"phase\":\"" + phase + "\",\"x\":" + mouse.Point.X + ",\"y\":" + mouse.Point.Y + "}");
            } else if (down && !decision.Suppress) Emit("{\"type\":\"pointer-down\"}");
            return decision.Suppress ? new IntPtr(1) : CallNextHookEx(mouseHook, code, message, data);
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
                Decision decision = state.Apply(next, KeyIsDown);
                EmitTrigger(decision);
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
                    else if (message.Id == WM_TIMER && message.WParam == timer) PollFullscreen();
                    else { TranslateMessage(ref message); DispatchMessage(ref message); }
                }
                if (result == -1) throw new InvalidOperationException("原生消息循环中断。");
                if (failure != null) throw new InvalidOperationException(failure);
            } finally {
                activeFocusRequest = null;
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
            return new NativeConfig { requestId = "test-config", inputEnabled = true, shortcut = members };
        }
        static TriggerState Configured(params ShortcutMember[] members) {
            TriggerState result = new TriggerState();
            result.Apply(TestConfig(members));
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
            // 只运行状态机、坐标和序列化测试，不安装 hook 或发送真实输入。
            TriggerState state;
            Decision decision;
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
