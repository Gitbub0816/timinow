using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using TimiVet.ViewModels;

namespace TimiVet.Views;

public partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel;
    public MainWindow(MainViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;
        Closing += OnClosing;
    }

    private void OpenMini_Click(object sender, RoutedEventArgs e) => ((App)System.Windows.Application.Current).ShowMini();
    private void BearerToken_Changed(object sender, RoutedEventArgs e) { if (sender is PasswordBox box) _viewModel.Settings.BearerToken = box.Password; }
    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (((App)System.Windows.Application.Current).IsExiting) return;
        e.Cancel = true;
        Hide();
    }
}
