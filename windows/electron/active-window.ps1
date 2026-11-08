param([int]$IgnoreProcessId = 0)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    # 读取前台窗口元数据，可选只让该 HWND 绘制到内存，不改变焦点。
    Add-Type -AssemblyName System.Drawing
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace RabbitBall {
    public static class ForegroundWindowNative {
        [StructLayout(LayoutKind.Sequential)]
        public struct Rect {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct Point {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MonitorInfo {
            public uint Size;
            public Rect Monitor, Work;
            public uint Flags;
        }

        public sealed class CaptureResult {
            public Rect Bounds;
            public int ImageWidth, ImageHeight;
            public string ImageBase64;
            public byte[] ImageBitmap;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PrintWindow(IntPtr window, IntPtr target, uint flags);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetCursorPos(out Point point);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect rect, uint size);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern IntPtr GetDesktopWindow();

        [DllImport("user32.dll")]
        public static extern IntPtr GetShellWindow();

        [DllImport("user32.dll")]
        private static extern IntPtr GetTopWindow(IntPtr parent);

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr window, uint command);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr window, StringBuilder name, int length);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        private static extern int GetWindowLong(IntPtr window, int index);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(Point point, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
        private static extern int GetCloaked(IntPtr window, uint attribute, out int value, uint size);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetWindowTextLength(IntPtr window);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetWindowText(IntPtr window, StringBuilder text, int length);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetWindowRect(IntPtr window, out Rect rect);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsIconic(IntPtr window);

        public static bool IsCaptureTarget(IntPtr window, int ignoredProcessId, bool fallback = false) {
            if (window == IntPtr.Zero || window == GetDesktopWindow() || window == GetShellWindow() ||
                !IsWindowVisible(window) || IsIconic(window)) return false;
            uint processId;
            if (GetWindowThreadProcessId(window, out processId) == 0 || processId == 0 ||
                (ignoredProcessId > 0 && processId == (uint)ignoredProcessId)) return false;
            StringBuilder name = new StringBuilder(256);
            GetClassName(window, name, name.Capacity);
            string className = name.ToString();
            if (className == "Progman" || className == "WorkerW" || className == "Shell_TrayWnd" ||
                className == "Shell_SecondaryTrayWnd" || className == "#32768" || className == "tooltips_class32") return false;
            // 回退时跳过悬浮工具与不可激活提示；正常前台对话框仍保留。
            if (fallback && (GetWindowLong(window, -20) & (0x80 | 0x08000000)) != 0) return false;
            int cloaked;
            if (GetCloaked(window, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
            Rect rect;
            return GetWindowRect(window, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top &&
                MonitorFromWindow(window, 0) != IntPtr.Zero;
        }

        public static IntPtr SelectCaptureWindow(IntPtr foreground, int ignoredProcessId) {
            if (IsCaptureTarget(foreground, ignoredProcessId)) return foreground;
            Point cursor;
            MonitorInfo monitor = new MonitorInfo { Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)) };
            bool hasMonitor = GetCursorPos(out cursor) && GetMonitorInfo(MonitorFromPoint(cursor, 2), ref monitor);
            // 焦点无效时优先鼠标所在屏的最前应用；其他屏只作为没有本屏候选时的回退。
            IntPtr first = IntPtr.Zero;
            HashSet<IntPtr> visited = new HashSet<IntPtr>();
            for (IntPtr window = GetTopWindow(IntPtr.Zero); window != IntPtr.Zero && visited.Add(window);
                window = GetWindow(window, 2)) {
                if (!IsCaptureTarget(window, ignoredProcessId, true)) continue;
                if (first == IntPtr.Zero) first = window;
                Rect rect;
                if (hasMonitor && GetWindowRect(window, out rect) && rect.Left < monitor.Monitor.Right &&
                    rect.Right > monitor.Monitor.Left && rect.Top < monitor.Monitor.Bottom && rect.Bottom > monitor.Monitor.Top) return window;
            }
            return first;
        }

        public static CaptureResult CaptureWindow(IntPtr window) {
            Rect rect;
            if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("无法读取窗口截图边界。");
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) throw new InvalidOperationException("当前窗口没有可见区域。");
            // PW_RENDERFULLCONTENT=2：由指定窗口绘制，不回退到整屏截图。
            using (Bitmap source = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
                using (Graphics graphics = Graphics.FromImage(source)) {
                    IntPtr dc = graphics.GetHdc();
                    bool success;
                    try { success = PrintWindow(window, dc, 2); }
                    finally { graphics.ReleaseHdc(dc); }
                    if (!success) throw new InvalidOperationException("无法读取当前窗口的画面。");
                }
                double scale = Math.Min(1, Math.Min(1920d / width, 1200d / height));
                int outputWidth = Math.Max(1, (int)Math.Round(width * scale));
                int outputHeight = Math.Max(1, (int)Math.Round(height * scale));
                using (Bitmap output = new Bitmap(outputWidth, outputHeight, PixelFormat.Format24bppRgb)) {
                    using (Graphics graphics = Graphics.FromImage(output)) {
                        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        graphics.DrawImage(source, 0, 0, outputWidth, outputHeight);
                    }
                    using (MemoryStream memory = new MemoryStream()) {
                        output.Save(memory, ImageFormat.Png);
                        return new CaptureResult { Bounds = rect, ImageWidth = outputWidth,
                            ImageHeight = outputHeight, ImageBase64 = Convert.ToBase64String(memory.ToArray()) };
                    }
                }
            }
        }

        public static CaptureResult CaptureDesktop(int x, int y, int width, int height) {
            if (width <= 0 || height <= 0) throw new ArgumentException("显示器截图范围无效。");
            // 整个虚拟桌面保留物理像素；直接传输 BGRA，避免 PNG 编解码往返。
            using (Bitmap image = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
                using (Graphics graphics = Graphics.FromImage(image)) {
                    graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                }
                BitmapData data = image.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try {
                    byte[] pixels = new byte[checked(width * height * 4)];
                    Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
                    // 屏幕像素不带透明度；确保 NativeImage 与无损预览使用不透明 BGRA。
                    for (int offset = 3; offset < pixels.Length; offset += 4) pixels[offset] = 255;
                    return new CaptureResult { ImageWidth = width, ImageHeight = height, ImageBitmap = pixels };
                } finally { image.UnlockBits(data); }
            }
        }
    }
}
'@

    function Invoke-Capture {
        param([switch]$Capture, [switch]$CaptureDesktop, [int]$DesktopX, [int]$DesktopY, [int]$DesktopWidth, [int]$DesktopHeight)
        # 让窗口边界与鼠标位置都使用屏幕物理像素，避免高 DPI 下坐标被虚拟化。
        $previousDpiContext = [RabbitBall.ForegroundWindowNative]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
        if ($previousDpiContext -eq [IntPtr]::Zero) {
            throw '无法启用屏幕像素坐标模式。'
        }

        $cursorPoint = [RabbitBall.ForegroundWindowNative+Point]::new()
        if (-not [RabbitBall.ForegroundWindowNative]::GetCursorPos([ref]$cursorPoint)) {
            throw '无法读取鼠标位置。'
        }

        # 默认窗口可为空；显示器快照独立返回，保证此时仍能手动框选。
        $result = [ordered]@{
            handle = '0'
            title = ''
            processId = 0
            bounds = [ordered]@{ x = 0; y = 0; width = 0; height = 0 }
            cursor = [ordered]@{ x = $cursorPoint.X; y = $cursorPoint.Y }
        }
        if ($CaptureDesktop) {
            try {
                $desktopResult = [RabbitBall.ForegroundWindowNative]::CaptureDesktop($DesktopX, $DesktopY, $DesktopWidth, $DesktopHeight)
                $result.desktopBitmap = $desktopResult.ImageBitmap
                $result.desktopWidth = $desktopResult.ImageWidth
                $result.desktopHeight = $desktopResult.ImageHeight
            } catch {
                $result.desktopError = $_.Exception.GetBaseException().Message
            }
        }

        if ($Capture -or -not $CaptureDesktop) {
            $windowHandle = [RabbitBall.ForegroundWindowNative]::SelectCaptureWindow(
                [RabbitBall.ForegroundWindowNative]::GetForegroundWindow(), $IgnoreProcessId)
            if ($windowHandle -ne [IntPtr]::Zero) {
                try {
                    $windowRect = [RabbitBall.ForegroundWindowNative+Rect]::new()
                    $rectByteSize = [Runtime.InteropServices.Marshal]::SizeOf($windowRect)
                    $dwmResult = [RabbitBall.ForegroundWindowNative]::DwmGetWindowAttribute($windowHandle, 9, [ref]$windowRect, $rectByteSize)
                    if ($dwmResult -ne 0 -and -not [RabbitBall.ForegroundWindowNative]::GetWindowRect($windowHandle, [ref]$windowRect)) {
                        throw '无法读取应用窗口的边界。'
                    }
                    $windowProcessId = [uint32]0
                    if ([RabbitBall.ForegroundWindowNative]::GetWindowThreadProcessId($windowHandle, [ref]$windowProcessId) -eq 0) {
                        throw '应用窗口已不可用，请重试。'
                    }
                    $titleLength = [RabbitBall.ForegroundWindowNative]::GetWindowTextLength($windowHandle)
                    $windowTitle = [System.Text.StringBuilder]::new([Math]::Max(1, $titleLength + 1))
                    [void][RabbitBall.ForegroundWindowNative]::GetWindowText($windowHandle, $windowTitle, $windowTitle.Capacity)
                    $result.handle = $windowHandle.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
                    $result.title = $windowTitle.ToString()
                    $result.processId = [long]$windowProcessId
                    # 元信息读取可能受进程权限或退出影响，不能因此丢掉可用的截图。
                    $windowProcess = $null
                    try {
                        $windowProcess = [Diagnostics.Process]::GetProcessById([int]$windowProcessId)
                        $result.processName = $windowProcess.ProcessName
                        $description = $windowProcess.MainModule.FileVersionInfo.FileDescription
                        if (-not [string]::IsNullOrWhiteSpace($description)) { $result.appName = $description }
                    } catch {
                    } finally {
                        if ($null -ne $windowProcess) { $windowProcess.Dispose() }
                    }
                    if ($Capture) {
                        # PrintWindow 包含完整边框，坐标与实际截图使用同一范围。
                        $captureResult = [RabbitBall.ForegroundWindowNative]::CaptureWindow($windowHandle)
                        $windowRect = $captureResult.Bounds
                        $result.imageBase64 = $captureResult.ImageBase64
                        $result.imageWidth = $captureResult.ImageWidth
                        $result.imageHeight = $captureResult.ImageHeight
                    }
                    $result.bounds = [ordered]@{
                        x = $windowRect.Left
                        y = $windowRect.Top
                        width = $windowRect.Right - $windowRect.Left
                        height = $windowRect.Bottom - $windowRect.Top
                    }
                } catch {
                    $result.captureError = $_.Exception.GetBaseException().Message
                }
            }
        }
        return $result
    }
    function Write-CaptureResponse($envelope, $result) {
        $bitmap = $result.desktopBitmap
        if ($null -ne $bitmap) { $result.Remove('desktopBitmap') }
        if ($null -ne $bitmap) { $envelope.bitmapBytes = $bitmap.Length }
        [Console]::WriteLine(($envelope | ConvertTo-Json -Compress -Depth 6))
        if ($null -ne $bitmap) {
            [Console]::Out.Flush()
            $stream = [Console]::OpenStandardOutput()
            $stream.Write($bitmap, 0, $bitmap.Length)
            $stream.Flush()
        }
    }
    # 编译仅在启动时进行；空闲阻塞等待输入，不占用键鼠钩子线程。
    [Console]::WriteLine('{"type":"ready"}')
    while ($null -ne ($line = [Console]::ReadLine())) {
        $request = $line | ConvertFrom-Json
        try {
            if ($request.type -eq 'desktop') {
                $result = Invoke-Capture -CaptureDesktop -DesktopX $request.bounds.x -DesktopY $request.bounds.y -DesktopWidth $request.bounds.width -DesktopHeight $request.bounds.height
            } elseif ($request.type -eq 'window') {
                $result = Invoke-Capture -Capture
            } else { throw '未知截图请求。' }
            Write-CaptureResponse ([ordered]@{ type = 'result'; requestId = $request.requestId; result = $result }) $result
        } catch {
            [Console]::WriteLine(([ordered]@{ type = 'result'; requestId = $request.requestId; error = $_.Exception.GetBaseException().Message } | ConvertTo-Json -Compress))
        }
    }

} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
