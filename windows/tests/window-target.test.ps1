$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 加载实际原生类；不执行脚本的截图入口，也不以源码正则代替行为验证。
$taskSource = Get-Content (Join-Path $PSScriptRoot '../electron/active-window.ps1') -Raw -Encoding UTF8
$taskClass = [regex]::Match($taskSource, "(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (-not $taskClass.Success) { throw '未找到实际选窗原生类。' }
Add-Type -AssemblyName System.Drawing
$taskFixtureSource = @'
namespace RabbitBallWindowTests {
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using RabbitBall;

public static class WindowTargetTest {
    delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref ForegroundWindowNative.Rect bounds, IntPtr data);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    sealed class WindowClass {
        public uint Style;
        public WindowProc Procedure;
        public int ClassExtra, WindowExtra;
        public IntPtr Instance, Icon, Cursor, Background;
        public string Menu, Name;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClass(WindowClass value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool UnregisterClass(string name, IntPtr instance);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowEx(uint extended, string name, string title, uint style, int x, int y,
        int width, int height, IntPtr owner, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string name, string title);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc callback, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, uint attribute, ref int value, uint size);
    static readonly WindowProc procedure = DefWindowProc;
    static readonly List<IntPtr> windows = new List<IntPtr>();
    static readonly List<string> classes = new List<string>();
    static int assertions;
    static void Assert(bool condition, string label) {
        assertions++;
        if (!condition) throw new InvalidOperationException(label);
    }
    static void Register(string name) {
        if (RegisterClass(new WindowClass { Procedure = procedure, Instance = GetModuleHandle(null), Name = name }) == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "注册测试窗口类失败：" + name);
        classes.Add(name);
    }
    static IntPtr Create(string name = "RabbitBallTargetFixture", uint extended = 0, bool visible = true,
        IntPtr owner = default(IntPtr), int x = 20, int y = 20) {
        IntPtr window = CreateWindowEx(extended, name, "RabbitBall window-target fixture", 0x00CF0000,
            x, y, 240, 120, owner, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        if (window == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "创建测试窗口失败：" + name);
        windows.Add(window);
        if (visible) ShowWindow(window, 4);
        return window;
    }
    static void DestroyAll() {
        for (int index = windows.Count - 1; index >= 0; index--) DestroyWindow(windows[index]);
        windows.Clear();
    }
    static void TestMultipleMonitors() {
        List<ForegroundWindowNative.Rect> monitors = new List<ForegroundWindowNative.Rect>();
        IntPtr previousDpi = ForegroundWindowNative.SetThreadDpiAwarenessContext(new IntPtr(-4));
        IntPtr foreground = ForegroundWindowNative.GetForegroundWindow();
        string name = "RabbitBallMultiMonitorFixture";
        bool registered = false;
        try {
            if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero,
                delegate(IntPtr monitor, IntPtr dc, ref ForegroundWindowNative.Rect bounds, IntPtr data) {
                    monitors.Add(bounds); return true;
                }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "枚举实际显示器失败");
            if (monitors.Count < 2) { Console.WriteLine("SKIP: 多屏选窗回归需要至少两台显示器"); return; }
            ForegroundWindowNative.Point cursor;
            Assert(ForegroundWindowNative.GetCursorPos(out cursor), "读取实际输入桌面的鼠标位置失败");
            int nearby = monitors.FindIndex(delegate(ForegroundWindowNative.Rect rect) {
                return cursor.X >= rect.Left && cursor.X < rect.Right && cursor.Y >= rect.Top && cursor.Y < rect.Bottom;
            });
            Assert(nearby >= 0, "鼠标应位于已连接显示器内");
            ForegroundWindowNative.Rect local = monitors[nearby], remote = monitors[(nearby + 1) % monitors.Count];
            Register(name); registered = true;
            // 仅此用例需要实际输入桌面；窗口先隐藏创建，再不激活显示，最后统一销毁。
            IntPtr near = Create(name, visible: false, x: local.Left + 20, y: local.Top + 20);
            IntPtr far = Create(name, visible: false, x: remote.Left + 20, y: remote.Top + 20);
            ShowWindow(near, 4); ShowWindow(far, 4);
            Assert(SetWindowPos(near, new IntPtr(-1), 0, 0, 0, 0, 0x13) &&
                SetWindowPos(far, new IntPtr(-1), 0, 0, 0, 0, 0x13), "设置两屏 fixture 的真实 Z 序失败");
            Assert(ForegroundWindowNative.SelectCaptureWindow(IntPtr.Zero, 0) == near,
                "鼠标屏候选应优先于另一屏更高 Z 序候选");
            Assert(ForegroundWindowNative.SelectCaptureWindow(far, 0) == far,
                "另一屏的有效前台仍应优先于鼠标屏候选");
        } finally {
            DestroyAll();
            if (registered) { UnregisterClass(name, GetModuleHandle(null)); classes.Remove(name); }
            if (previousDpi != IntPtr.Zero) ForegroundWindowNative.SetThreadDpiAwarenessContext(previousDpi);
        }
        Assert(ForegroundWindowNative.GetForegroundWindow() == foreground, "多屏 fixture 不能改变用户前台窗口");
    }
    static void TestIsolatedDesktop() {
        Register("RabbitBallTargetFixture");
        Register("CabinetWClass");
        foreach (string shell in new string[] { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" }) {
            Register(shell);
            IntPtr window = Create(shell);
            Assert(!ForegroundWindowNative.IsCaptureTarget(window, 0), shell + " 外壳不能作为截图目标");
            DestroyAll();
        }
        Assert(ForegroundWindowNative.SelectCaptureWindow(IntPtr.Zero, 0) == IntPtr.Zero, "无合适窗口应返回零句柄");
        IntPtr app = Create();
        Assert(ForegroundWindowNative.IsCaptureTarget(app, 0), "正常应用窗口应可选");
        Assert(!ForegroundWindowNative.IsCaptureTarget(app, (int)GetCurrentProcessId()), "应排除自身进程");
        Assert(ForegroundWindowNative.SelectCaptureWindow(app, (int)GetCurrentProcessId()) == IntPtr.Zero, "仅有自身窗口时不能回退到自身");
        IntPtr explorer = Create("CabinetWClass");
        Assert(ForegroundWindowNative.IsCaptureTarget(explorer, 0), "Explorer 文件夹类应可选");
        IntPtr dialog = Create("#32770", owner: app);
        Assert(ForegroundWindowNative.IsCaptureTarget(dialog, 0, true), "有 owner 的普通对话框也应可选");
        Assert(ForegroundWindowNative.SelectCaptureWindow(dialog, 0) == dialog, "普通前台对话框优先于主窗口");
        DestroyAll();
        IntPtr hidden = Create(visible: false);
        Assert(!ForegroundWindowNative.IsCaptureTarget(hidden, 0), "隐藏窗口应排除");
        IntPtr minimized = Create(); ShowWindow(minimized, 7);
        Assert(!ForegroundWindowNative.IsCaptureTarget(minimized, 0), "最小化窗口应排除");
        IntPtr offscreen = Create(x: -32000, y: -32000);
        Assert(!ForegroundWindowNative.IsCaptureTarget(offscreen, 0), "完全离屏窗口应排除");
        DestroyAll();
        IntPtr tool = Create(extended: 0x80);
        Assert(ForegroundWindowNative.IsCaptureTarget(tool, 0), "前台工具窗口仍允许明确截图");
        Assert(!ForegroundWindowNative.IsCaptureTarget(tool, 0, true), "回退应排除工具窗口");
        IntPtr hint = Create(extended: 0x08000000);
        Assert(!ForegroundWindowNative.IsCaptureTarget(hint, 0, true), "回退应排除不可激活提示");
        Assert(ForegroundWindowNative.SelectCaptureWindow(IntPtr.Zero, 0) == IntPtr.Zero, "只有悬浮工具时无回退窗口");
        DestroyAll();
        IntPtr lower = Create(), upper = Create();
        Assert(SetWindowPos(upper, IntPtr.Zero, 0, 0, 0, 0, 0x13), "调整测试窗口 Z 序失败");
        Assert(ForegroundWindowNative.SelectCaptureWindow(lower, 0) == lower, "有效前台优先，不被更高 Z 序窗口替换");
        Assert(ForegroundWindowNative.SelectCaptureWindow(IntPtr.Zero, 0) == upper, "无效前台应回退到最高合适窗口");
        Assert(SetWindowPos(lower, IntPtr.Zero, 0, 0, 0, 0, 0x13), "反转测试窗口 Z 序失败");
        Assert(ForegroundWindowNative.SelectCaptureWindow(IntPtr.Zero, 0) == lower, "回退必须随实际 Z 序变化");
        int cloak = 1;
        int cloakResult = DwmSetWindowAttribute(lower, 13, ref cloak, 4);
        if (cloakResult == 0) {
            Assert(!ForegroundWindowNative.IsCaptureTarget(lower, 0), "DWM cloaked 窗口应排除");
            Assert(ForegroundWindowNative.SelectCaptureWindow(lower, 0) == upper, "cloaked 前台应回退到下一合适窗口");
        } else Console.WriteLine("SKIP: 当前 desktop 不支持设置 DWM cloak (HRESULT=" + cloakResult + ")");
        DestroyAll();
        Assert(ForegroundWindowNative.SelectCaptureWindow(IntPtr.Zero, 0) == IntPtr.Zero, "销毁全部 fixture 后应无候选");
    }
    public static void Run() {
        Assert(!ForegroundWindowNative.IsCaptureTarget(ForegroundWindowNative.GetDesktopWindow(), 0), "真实桌面不能作为应用截图目标");
        Assert(!ForegroundWindowNative.IsCaptureTarget(ForegroundWindowNative.GetShellWindow(), 0), "真实 shell 不能作为应用截图目标");
        foreach (string shell in new string[] { "Progman", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" }) {
            IntPtr window = FindWindow(shell, null);
            if (window != IntPtr.Zero) Assert(!ForegroundWindowNative.IsCaptureTarget(window, 0), "真实外壳应排除：" + shell);
        }
        TestMultipleMonitors();
        IntPtr desktop = CreateDesktop("RabbitBallTargetTest-" + Guid.NewGuid().ToString("N"), IntPtr.Zero,
            IntPtr.Zero, 0, 0x01FF, IntPtr.Zero);
        if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "创建隔离测试 desktop 失败");
        Exception failure = null;
        Thread thread = new Thread(delegate() {
            try {
                if (!SetThreadDesktop(desktop)) throw new Win32Exception(Marshal.GetLastWin32Error(), "绑定隔离测试 desktop 失败");
                TestIsolatedDesktop();
            } catch (Exception error) { failure = error; }
            finally {
                DestroyAll();
                foreach (string name in classes) UnregisterClass(name, GetModuleHandle(null));
            }
        });
        // 不调用 SwitchDesktop 或 SetForegroundWindow，fixture 始终不显示在用户桌面。
        try { thread.Start(); thread.Join(); }
        finally { CloseDesktop(desktop); }
        if (failure != null) throw failure;
        Console.WriteLine("window-target native assertions passed: " + assertions);
    }
}
}
'@
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition ($taskClass.Groups[1].Value + "`n" + $taskFixtureSource)
[RabbitBallWindowTests.WindowTargetTest]::Run()
