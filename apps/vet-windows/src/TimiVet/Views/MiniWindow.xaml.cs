using System.ComponentModel;
using System.Windows;
using System.Windows.Input;
using TimiVet.ViewModels;

namespace TimiVet.Views;

public partial class MiniWindow : Window
{
    private readonly MainViewModel _viewModel;
    private bool _geometryRestored;

    public MiniWindow(MainViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;
        RestoreGeometry();
        LocationChanged += (_, _) => SaveGeometry();
        SizeChanged += (_, _) => SaveGeometry();
        Closing += OnClosing;
    }

    /// <summary>Applies remembered position/size instead of the hardcoded Left="80" Top="80" XAML defaults.</summary>
    private void RestoreGeometry()
    {
        var settings = _viewModel.Settings;
        if (settings.MiniWindowLeft is double left) Left = left;
        if (settings.MiniWindowTop is double top) Top = top;
        if (settings.MiniWindowWidth is double width && width >= MinWidth) Width = width;
        if (settings.MiniWindowHeight is double height && height >= MinHeight) Height = height;
        _geometryRestored = true;
    }

    private void SaveGeometry()
    {
        if (!_geometryRestored) return;
        var settings = _viewModel.Settings;
        settings.MiniWindowLeft = Left;
        settings.MiniWindowTop = Top;
        settings.MiniWindowWidth = Width;
        settings.MiniWindowHeight = Height;
    }

    private void Header_MouseLeftButtonDown(object sender, MouseButtonEventArgs e) { if (e.ButtonState == MouseButtonState.Pressed) DragMove(); }
    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void Hide_Click(object sender, RoutedEventArgs e) => Hide();
    private void OpenMain_Click(object sender, RoutedEventArgs e) => ((App)System.Windows.Application.Current).ShowMain();
    private void Topmost_Click(object sender, RoutedEventArgs e) => Topmost = _viewModel.Settings.MiniWindowTopmost;

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        SaveGeometry();
        if (((App)System.Windows.Application.Current).IsExiting) return;
        e.Cancel = true;
        Hide();
    }
}
