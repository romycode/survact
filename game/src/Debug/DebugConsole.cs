using Godot;
using Survact.Game.Controls;

namespace Survact.Game.Debug;

/// <summary>
/// Drop-down developer console (debug_console action: the key left of "1", or F1).
/// Owns only input/output; executing is the parent's job (signal up: CommandSubmitted).
/// </summary>
public partial class DebugConsole : CanvasLayer
{
    [Signal] public delegate void CommandSubmittedEventHandler(string line);

    private const int MaxHistory = 50;

    private Control _panel = null!;
    private RichTextLabel _log = null!;
    private LineEdit _input = null!;
    private readonly List<string> _history = [];
    private int _historyCursor;

    public override void _Ready()
    {
        _panel = GetNode<Control>("%Panel");
        _log = GetNode<RichTextLabel>("%Log");
        _input = GetNode<LineEdit>("%Input");

        _panel.Visible = false;
        _input.TextSubmitted += OnTextSubmitted;
        _input.GuiInput += OnInputGuiInput;
        Print("[color=#8a8370]Survact dev console — type 'help'[/color]");
    }

    // _Input (not _UnhandledInput): must catch the toggle key before the LineEdit types it.
    public override void _Input(InputEvent @event)
    {
        if (!@event.IsActionPressed(Actions.DebugConsole)) return;
        Toggle();
        GetViewport().SetInputAsHandled();
    }

    public void Toggle()
    {
        _panel.Visible = !_panel.Visible;
        if (_panel.Visible) _input.GrabFocus();
        else _input.ReleaseFocus();
    }

    public void Print(string bbcode)
    {
        if (bbcode.Length > 0) _log.AppendText(bbcode + "\n");
    }

    public void ClearLog() => _log.Clear();

    private void OnTextSubmitted(string text)
    {
        _input.Clear();
        text = text.Trim();
        if (text.Length == 0) return;

        if (_history.Count == 0 || _history[^1] != text) _history.Add(text);
        if (_history.Count > MaxHistory) _history.RemoveAt(0);
        _historyCursor = _history.Count;

        Print($"[color=#c8a464]> {text.Replace("[", "[lb]")}[/color]");
        EmitSignal(SignalName.CommandSubmitted, text);
    }

    private void OnInputGuiInput(InputEvent @event)
    {
        if (@event is not InputEventKey { Pressed: true } key || _history.Count == 0) return;

        if (key.Keycode == Key.Up) _historyCursor = Math.Max(0, _historyCursor - 1);
        else if (key.Keycode == Key.Down) _historyCursor = Math.Min(_history.Count, _historyCursor + 1);
        else return;

        _input.Text = _historyCursor < _history.Count ? _history[_historyCursor] : "";
        _input.CaretColumn = _input.Text.Length;
        _input.AcceptEvent();
    }
}
