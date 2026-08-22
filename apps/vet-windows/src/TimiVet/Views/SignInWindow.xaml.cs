using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using TimiVet.Models;
using TimiVet.ViewModels;

// The project enables both UseWPF and UseWindowsForms — WinForms only for the
// tray icon — so `TextBox`, `KeyEventArgs`, and `Clipboard` each name two
// different types once implicit usings pull in System.Windows.Forms. These
// aliases pin the WPF ones for this file.
using TextBox = System.Windows.Controls.TextBox;
using KeyEventArgs = System.Windows.Input.KeyEventArgs;
using Clipboard = System.Windows.Clipboard;

namespace TimiVet.Views;

public partial class SignInWindow : Window
{
    private readonly SignInViewModel _viewModel;
    private readonly TextBox[] _otpBoxes;
    private bool _suppressOtpEvents;

    public SignInWindow(SignInViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;
        _otpBoxes = [Otp0, Otp1, Otp2, Otp3, Otp4, Otp5];
        _viewModel.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(SignInViewModel.IsCodeStep) && viewModel.IsCodeStep) ResetOtpBoxes();
            if (e.PropertyName == nameof(SignInViewModel.IsPasswordStep) && viewModel.IsPasswordStep) PasswordInput.Clear();
        };
        _viewModel.SignedIn += (_, _) => { DialogResult = true; Close(); };
    }

    public SessionDescriptor? Session => _viewModel.Session;

    private void PasswordBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        if (sender is PasswordBox box) _viewModel.Password = box.Password;
    }

    private void ResetOtpBoxes()
    {
        _suppressOtpEvents = true;
        foreach (var box in _otpBoxes) box.Text = "";
        _suppressOtpEvents = false;
        Otp0.Focus();
    }

    private void Otp_PreviewTextInput(object sender, TextCompositionEventArgs e)
    {
        e.Handled = !e.Text.All(char.IsDigit);
    }

    private void Otp_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (_suppressOtpEvents || sender is not TextBox box) return;

        if (box.Text.Length > 1)
        {
            // Paste landed in a single box — distribute the digits across the remaining boxes.
            DistributeDigits(box.Text, Array.IndexOf(_otpBoxes, box));
            return;
        }

        if (box.Text.Length == 1)
        {
            var index = Array.IndexOf(_otpBoxes, box);
            if (index >= 0 && index < _otpBoxes.Length - 1) _otpBoxes[index + 1].Focus();
        }

        SubmitIfComplete();
    }

    private void Otp_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is not TextBox box) return;
        var index = Array.IndexOf(_otpBoxes, box);

        if (e.Key == Key.Back && string.IsNullOrEmpty(box.Text) && index > 0)
        {
            _otpBoxes[index - 1].Focus();
            _otpBoxes[index - 1].SelectAll();
            e.Handled = true;
            return;
        }

        if (e.Key == Key.V && Keyboard.Modifiers == ModifierKeys.Control)
        {
            if (System.Windows.Clipboard.ContainsText())
            {
                DistributeDigits(System.Windows.Clipboard.GetText(), index);
            }
            e.Handled = true;
        }
    }

    private void DistributeDigits(string text, int startIndex)
    {
        var digits = new string(text.Where(char.IsDigit).ToArray());
        if (digits.Length == 0) return;

        _suppressOtpEvents = true;
        var boxIndex = Math.Max(startIndex, 0);
        for (var i = 0; i < digits.Length && boxIndex < _otpBoxes.Length; i++, boxIndex++)
            _otpBoxes[boxIndex].Text = digits[i].ToString();
        _suppressOtpEvents = false;

        var nextFocus = Math.Min(boxIndex, _otpBoxes.Length - 1);
        _otpBoxes[nextFocus].Focus();
        _otpBoxes[nextFocus].SelectAll();
        SubmitIfComplete();
    }

    private void SubmitIfComplete()
    {
        var code = string.Concat(_otpBoxes.Select(b => b.Text));
        if (code.Length == _otpBoxes.Length) _ = _viewModel.SubmitCodeAsync(code);
    }
}
