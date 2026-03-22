# BabelFish Translator Bot

A real-time translation bot for [Talkomatic](https://classic.talkomatic.co). It reads what users type character-by-character and displays live translations in its own chat panel using Google Translate.

Users control the bot by typing commands directly in their own text box. No separate chat commands needed - just type alongside your normal message and the bot picks it up. Erase the command and the translation stops.

---

## How It Works

Every user in a Talkomatic room has a text buffer that updates in real time as they type. BabelFish monitors all user buffers, detects translation commands, strips the commands from the text, sends the remaining text to Google Translate, and renders the results in the bot's own buffer as a live dashboard.

```
┌─────────────────────────────────────────────┐
│ Alice's box:                                │
│ Hello how are you today !lang spanish       │
├─────────────────────────────────────────────┤
│ Bob's box:                                  │
│ !translate Alice french                     │
├─────────────────────────────────────────────┤
│ BabelFish's box:                            │
│ 🌍 BABEL FISH TRANSLATOR 🌍                │
│ [Alice » SPANISH]                           │
│ Hola, ¿cómo estás hoy?                      │
│ -------------------------                   │
│ [Alice » FRENCH]                            │
│ Bonjour, comment allez-vous aujourd'hui ?   │
│ -------------------------                   │
└─────────────────────────────────────────────┘
```

Translations update as users type. If a user erases their command, the translation disappears from the dashboard automatically.

---

## Requirements

- Python 3.8+
- A Talkomatic bot token ([how to get one](https://classic.talkomatic.co/documentation.html#getting-started-with-bots))

## Installation

```bash
pip install "python-socketio[asyncio_client]" deep-translator
```

## Configuration

First, generate a bot token by running one of these commands in your terminal:

```bash
# Mac/Linux
curl -X POST https://classic.talkomatic.co/api/v1/bot-tokens/request

# Windows (PowerShell)
curl.exe -X POST https://classic.talkomatic.co/api/v1/bot-tokens/request
```

This returns a JSON response containing your token (starts with `tk_`).

Then open `babelfish.py` and set these two values near the top of the file:

```python
TOKEN   = 'tk_paste_your_token_here'  # Paste the token from the command above
ROOM_ID = '123456'                     # The 6-digit ID of the room to join
```

The bot joins an existing room. It does not create its own. Make sure the room exists before starting the bot.

## Running

```bash
python babelfish.py
```

You should see:

```
[+] Connected
[+] Signed in as BabelFish
[*] Joining existing room ID '123456'...
[+] Joined room: Room Name
```

To stop the bot, press `Ctrl+C`.

---

## User Commands

Users type these commands anywhere in their own text box. Commands can be mixed with regular text.

### Translate your own text

```
!lang <language>
```

Translates everything in your text box (minus the command itself) into the specified language.

**Examples:**

```
Hey everyone, what's going on? !lang spanish
```

```
I love programming !lang japanese
```

You can request multiple languages at once:

```
Good morning !lang french !lang german !lang korean
```

### Translate someone else's text

```
!translate <username> <language>
```

Translates another user's text box into the specified language. Use their exact Talkomatic username (case-insensitive).

**Examples:**

```
!translate Alice french
```

```
!translate Bob japanese
```

Multiple users can request translations of the same person into different languages simultaneously.

### Show the help menu

```
!help
```

Type `!help` anywhere in your text box to display the instruction panel in the bot's dashboard. Erase it to close the menu.

### Stop a translation

Just erase the command from your text box. The bot re-parses all buffers on every keystroke, so removing a command instantly removes its translation from the dashboard.

---

## Supported Languages

BabelFish uses Google Translate under the hood via the `deep-translator` library. Any language name that Google Translate accepts will work. Some common examples:

| Command                    | Language             |
| -------------------------- | -------------------- |
| `!lang spanish`            | Spanish              |
| `!lang french`             | French               |
| `!lang german`             | German               |
| `!lang japanese`           | Japanese             |
| `!lang korean`             | Korean               |
| `!lang arabic`             | Arabic               |
| `!lang chinese-simplified` | Chinese (Simplified) |
| `!lang portuguese`         | Portuguese           |
| `!lang russian`            | Russian              |
| `!lang hindi`              | Hindi                |

If an invalid language is typed (e.g. `!lang asdfgh`), the bot displays `[Language Not Found / Error]` for that entry.

---

## How It Works Internally

1. **Diff tracking** - The bot receives character-level diffs from Talkomatic's Socket.IO protocol (`add`, `delete`, `replace`, `full-replace`) and rebuilds each user's full text buffer locally.

2. **Command parsing** - On every incoming diff, the bot scans all user buffers with regex to find `!lang`, `!translate`, and `!help` commands. This means the command state is always derived from what's currently in the text boxes, not from a history of past commands.

3. **Text cleaning** - Before sending text to Google Translate, all bot commands are stripped out so only the actual message content gets translated.

4. **Async translation** - Each translation request runs in a background thread via `asyncio.to_thread()` so the API call doesn't block the event loop. If a user types another character before the previous translation finishes, the old task is cancelled and a new one starts.

5. **Dashboard rendering** - After every state change, the bot rebuilds its entire text buffer as a formatted dashboard and emits a single `full-replace` diff. The output is capped at 14,900 characters to stay within Talkomatic's 15,000 character limit.

6. **AFK handling** - The bot responds to `afk warning` events automatically to avoid being kicked for inactivity. Dashboard updates also reset the AFK timer since they count as `chat update` events.

---

## Limitations

- **Google Translate rate limits** - Heavy usage (many users typing fast with multiple languages) may hit Google Translate's informal rate limits. The 50ms debounce delay on each translation helps, but very active rooms could still see occasional slowdowns.
- **Room capacity** - Talkomatic rooms hold 5 users max. The bot takes one slot, leaving 4 for humans.
- **One room at a time** - The bot joins a single room specified by `ROOM_ID`. To use it in a different room, stop the bot, change the ID, and restart.
- **Username matching** - The `!translate <username>` command matches against exact Talkomatic usernames. If a username contains spaces, it cannot be targeted with this command (the regex expects a single word).

---

## License

MIT
