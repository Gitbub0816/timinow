using System.Windows;

namespace TimiVet.Views;

/// <summary>
/// Keeps a window inside the desktop it actually has.
/// </summary>
/// <remarks>
/// The console asked for 1440x920 device-independent pixels. Those are not
/// screen pixels: on a 1920x1080 display at 125% scaling the desktop is
/// 1536x864 of them, and at 150% it is 1280x720. So the window was taller than
/// the space it had, WindowStartupLocation.CenterScreen centred it anyway, and
/// the overflow went half above the top edge — taking the title bar with it,
/// and with the title bar minimize, maximize and close. What was left looked
/// like an app with no chrome and a cropped first row, and the only ways to
/// close it were Alt+F4 and the tray.
///
/// It is worth being clear that this is not a layout bug that a bigger monitor
/// hides. Every developer machine involved runs at 100%, where 1440x920 fits
/// with room to spare and none of this happens; 125% is the Windows default on
/// most laptops sold in the last five years, which is to say on most of the
/// machines a clinic will actually run this on.
///
/// SystemParameters.WorkArea is in the same units as Width and Height and
/// already excludes the taskbar, wherever it is docked. Nothing here shrinks a
/// window that already fits.
/// </remarks>
public static class WindowFit
{
    public static void FitToWorkArea(this Window window)
    {
        var area = SystemParameters.WorkArea;
        if (area.Width <= 0 || area.Height <= 0) return;

        // Minimums win over Width/Height in WPF's measure pass, so a minimum
        // larger than the screen puts the window back over the edge however
        // carefully Width was chosen.
        window.MinWidth = Math.Min(window.MinWidth, area.Width);
        window.MinHeight = Math.Min(window.MinHeight, area.Height);
        window.MaxWidth = Math.Min(window.MaxWidth, area.Width);
        window.MaxHeight = Math.Min(window.MaxHeight, area.Height);

        // SizeToContent decides that dimension itself; forcing a number here
        // would just be overwritten, and the MaxWidth/MaxHeight clamp above is
        // what actually bounds those windows.
        if (window.SizeToContent is not (SizeToContent.Width or SizeToContent.WidthAndHeight))
        {
            window.Width = Math.Max(window.MinWidth, Math.Min(window.Width, area.Width));
        }
        if (window.SizeToContent is not (SizeToContent.Height or SizeToContent.WidthAndHeight))
        {
            window.Height = Math.Max(window.MinHeight, Math.Min(window.Height, area.Height));
        }

        window.WindowStartupLocation = WindowStartupLocation.Manual;
        Centre(window, area);

        // A SizeToContent window settles on its height after this runs — the
        // sign-in window grows by a whole step when Clerk answers with a
        // one-time-code field — so it is re-centred when it changes rather
        // than once at construction. ResizeMode=NoResize there means a window
        // that ends up off the top cannot be dragged back.
        window.SizeChanged += (_, _) => Centre(window, SystemParameters.WorkArea);
    }

    private static void Centre(Window window, Rect area)
    {
        if (window.WindowState != WindowState.Normal) return;
        var width = double.IsNaN(window.Width) ? window.ActualWidth : window.Width;
        var height = double.IsNaN(window.Height) ? window.ActualHeight : window.Height;
        if (width <= 0 || height <= 0) return;
        window.Left = area.Left + Math.Max(0, (area.Width - width) / 2);
        window.Top = area.Top + Math.Max(0, (area.Height - height) / 2);
    }
}
