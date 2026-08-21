using System.ComponentModel;
using System.Windows;
using System.Windows.Input;
using TimiVet.ViewModels;

namespace TimiVet.Views;

public partial class MiniWindow : Window
{
    private readonly MainViewModel _viewModel;
    public MiniWindow(MainViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;
        Closing += OnClosing;
    }

    private void Header_MouseLeftButtonDown(object sender, MouseButtonEventArgs e) { if (e.ButtonState == MouseButtonState.Pressed) DragMove(); }
    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void Hide_Click(object sender, RoutedEventArgs e) => Hide();
    private void OpenMain_Click(object sender, RoutedEventArgs e) => ((App)System.Windows.Application.Current).ShowMain();
    private void Topmost_Click(object sender, RoutedEventArgs e) => Topmost = _viewModel.Settings.MiniWindowTopmost;
    private void OnClosing(object? sender, CancelEventArgs e) { if (((App)System.Windows.Application.Current).IsExiting) return; e.Cancel = true; Hide(); }
}
