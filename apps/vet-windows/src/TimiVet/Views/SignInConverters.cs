using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace TimiVet.Views;

/// <summary>Small, purpose-built converters for SignInWindow.xaml — none of this touches Clerk's own UI or branding.</summary>
public sealed class StringEmptyToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
        => string.IsNullOrWhiteSpace(value as string) ? Visibility.Collapsed : Visibility.Visible;
    public object ConvertBack(object? value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

public sealed class InverseBooleanToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
        => value is bool b && b ? Visibility.Collapsed : Visibility.Visible;
    public object ConvertBack(object? value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

public sealed class PositiveIntToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
        => value is int i && i > 0 ? Visibility.Visible : Visibility.Collapsed;
    public object ConvertBack(object? value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

public sealed class StrategyLabelConverter : IValueConverter
{
    // Only the two one-time-code strategies ever reach this converter: SignInViewModel filters
    // everything else out of StrategyOptions, so a "Continue" fallback here is a bug's label, not a path.
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture) => (value as string) switch
    {
        "email_code" => "Email me a code",
        "phone_code" => "Text me a code",
        _ => "Continue",
    };
    public object ConvertBack(object? value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}
