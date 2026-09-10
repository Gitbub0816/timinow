using System.ComponentModel;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using TimiVet.ViewModels;

namespace TimiVet.Views;

public partial class MiniWindow : Window
{
    private readonly MainViewModel _viewModel;
    private bool _geometryRestored;

    // WS_EX_NOACTIVATE: clicking the pill's buttons answers a request without
    // yanking keyboard focus away from whatever the front desk was typing —
    // the WPF spelling of the Mac panel's .nonactivatingPanel.
    // WS_EX_TOOLWINDOW keeps it out of Alt-Tab, like .utilityWindow.
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int GetWindowLong(nint hwnd, int index);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int SetWindowLong(nint hwnd, int index, int value);

    public MiniWindow(MainViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;
        RestoreGeometry();
        LocationChanged += (_, _) => SaveGeometry();
        // SizeToContent decides the frame now (the pill measures ~150pt wide
        // idle and 320 as a decision card); pinning the RIGHT edge as the
        // width changes makes growth read as the pill expanding leftward and
        // downward from its corner — the same corner FloatingPanel.fit(to:)
        // holds fixed on the Mac — instead of the window jumping.
        SizeChanged += OnSizeChangedPinRightEdge;
        SourceInitialized += OnSourceInitialized;
        Closing += OnClosing;
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var handle = new WindowInteropHelper(this).Handle;
        SetWindowLong(handle, GWL_EXSTYLE, GetWindowLong(handle, GWL_EXSTYLE) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
    }

    private void OnSizeChangedPinRightEdge(object sender, SizeChangedEventArgs e)
    {
        if (!_geometryRestored || !IsLoaded) return;
        if (e.PreviousSize.Width > 0 && e.WidthChanged)
        {
            Left += e.PreviousSize.Width - e.NewSize.Width;
        }
        SaveGeometry();
    }

    /// <summary>
    /// Position only. Width/height are the content's to decide now — the old
    /// build restored a person-dragged 430x400 here, which is exactly the
    /// stale-geometry a content-sized pill must ignore.
    /// </summary>
    private void RestoreGeometry()
    {
        var settings = _viewModel.Settings;
        if (settings.MiniWindowLeft is double left) Left = left;
        if (settings.MiniWindowTop is double top) Top = top;
        _geometryRestored = true;
    }

    private void SaveGeometry()
    {
        if (!_geometryRestored) return;
        var settings = _viewModel.Settings;
        settings.MiniWindowLeft = Left;
        settings.MiniWindowTop = Top;
    }

    /// <summary>
    /// Re-asserts topmost when something steals the z-order — the closest
    /// Windows gets to the Mac panel's "stay above everything" level, since
    /// Win32 has no window level above Topmost to escalate to.
    /// </summary>
    public void ReassertTopmostIfWanted()
    {
        if (!_viewModel.Settings.MiniWindowTopmost || !_viewModel.Settings.StayAboveEverything) return;
        Topmost = false;
        Topmost = true;
    }

    /// <summary>The whole surface drags — the Mac pill's isMovableByWindowBackground.</summary>
    private void Surface_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed) DragMove();
    }

    private void Hide_Click(object sender, RoutedEventArgs e) => Hide();

    private void OpenMain_Click(object sender, RoutedEventArgs e)
    {
        // Same handoff as the Mac pill: the workspace opens already on the
        // patient the card was showing.
        if (_viewModel.LeadRequest is { } lead) _viewModel.SelectedRequest = lead;
        ((App)System.Windows.Application.Current).ShowMain();
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        SaveGeometry();
        if (((App)System.Windows.Application.Current).IsExiting) return;
        e.Cancel = true;
        Hide();
    }
}
