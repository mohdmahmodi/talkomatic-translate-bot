import os
import sys
import asyncio
import socketio
import re
from deep_translator import GoogleTranslator

# --- CONFIGURATION ---
SERVER  = 'https://classic.talkomatic.co'

# --- HOW TO GET A TOKEN ---
# Run one of the following commands in your terminal to generate a token:
# Mac/Linux:            curl -X POST https://classic.talkomatic.co/api/v1/bot-tokens/request
# Windows (PowerShell): curl.exe -X POST https://classic.talkomatic.co/api/v1/bot-tokens/request
TOKEN   = 'tk_0636dfd04a86ba04b1ec2339cdca396201378b349fff19313552d70ab209b6a2' # Paste your generated token here
ROOM_ID = '219588' # The bot will directly join this existing room

if not TOKEN or TOKEN == 'tk_...':
    print("Please set your TOKEN in the script.")
    sys.exit(1)

# We use the AsyncClient so API translation calls don't block chat processing
sio = socketio.AsyncClient(reconnection=True, reconnection_attempts=10)

# --- STATE MANAGEMENT ---
my_user_id = None
users_info = {}       # user_id -> username
user_messages = {}    # user_id -> current raw message text
user_targets = {}     # user_id -> set of target language codes requested for this user
translations = {}     # user_id -> { lang: translated_text }
live_tasks = {}       # user_id -> asyncio.Task (tracks the real-time API requests)

async def render_dashboard():
    """
    Builds the UI for the bot's buffer. 
    It dynamically checks if anyone typed !help, and renders all active translations.
    """
    lines = ["🌍 BABEL FISH TRANSLATOR 🌍"]
    
    # Check if ANY user has '!help' anywhere in their buffer
    show_help = any('!help' in msg.lower() for msg in user_messages.values())
    
    if show_help:
        lines.extend([
            "--- 📖 HELP MENU ---",
            "1. Translate YOUR text: Type '!lang spanish' anywhere.",
            "2. Translate SOMEONE ELSE: Type '!translate Name french'",
            "3. Stop: Just erase the command from your box.",
            "4. Close this menu: Erase '!help' from your box.",
            "--------------------"
        ])
    else:
        lines.append("Type '!help' anywhere in your box for instructions!")
        lines.append("--------------------------------------------------")
        
    active_blocks = 0
    # Iterate through users who have active requested translations
    for uid, targets in user_targets.items():
        if not targets or uid not in users_info: 
            continue
            
        username = users_info[uid]
        for lang in sorted(targets):
            active_blocks += 1
            # Get the translated text (default to ... if still loading)
            trans_text = translations.get(uid, {}).get(lang, "...")
            
            lines.append(f"[{username} » {lang.upper()}]")
            lines.append(trans_text)
            lines.append("-------------------------")
            
    if active_blocks == 0 and not show_help:
        lines.append("\n(Waiting for someone to request a translation...)")

    # Combine and emit. (We cap at ~14.9k characters to respect Talkomatic's 15k limit)
    dashboard_text = "\n".join(lines)[:14900]
    await sio.emit('chat update', {
        'diff': {'type': 'full-replace', 'text': dashboard_text}
    })

def parse_all_commands():
    """
    Reads everyone's current text boxes to figure out what translations should be active.
    This means if someone deletes a command, the translation naturally stops.
    Returns: A dictionary mapping user_id -> set(target_languages)
    """
    new_targets = {}
    for uid, msg in user_messages.items():
        
        # Check for self-translations: !lang <language>
        for match in re.finditer(r'!lang\s+([a-zA-Z]+)', msg, re.IGNORECASE):
            lang = match.group(1).lower()
            new_targets.setdefault(uid, set()).add(lang)
            
        # Check for other-translations: !translate <username> <language>
        for match in re.finditer(r'!translate\s+([a-zA-Z0-9_]+)\s+([a-zA-Z]+)', msg, re.IGNORECASE):
            target_name = match.group(1).lower()
            target_lang = match.group(2).lower()
            
            # Resolve the typed username to their actual User ID
            target_uid = None
            for check_uid, check_name in users_info.items():
                if check_name.lower() == target_name:
                    target_uid = check_uid
                    break
            
            if target_uid:
                new_targets.setdefault(target_uid, set()).add(target_lang)
                
    return new_targets

def get_clean_text(msg):
    """Removes the bot commands from the text before sending it to Google Translate."""
    msg = re.sub(r'!lang\s+[a-zA-Z]+', '', msg, flags=re.IGNORECASE)
    msg = re.sub(r'!translate\s+[a-zA-Z0-9_]+\s+[a-zA-Z]+', '', msg, flags=re.IGNORECASE)
    msg = re.sub(r'!help', '', msg, flags=re.IGNORECASE)
    return msg.strip()

async def live_translate(user_id, text, target_langs):
    """
    Translates text into multiple languages concurrently.
    """
    try:
        # Micro-delay to prevent out-of-order execution when typing fast.
        # Lowered to 0.05s for a faster, snappier feel.
        await asyncio.sleep(0.05)
        
        async def fetch_trans(lang):
            # Run the synchronous API call in a background thread
            trans = await asyncio.to_thread(
                GoogleTranslator(source='auto', target=lang).translate, text
            )
            return lang, trans
        
        # Trigger all requested languages for this user at the same time
        results = await asyncio.gather(*(fetch_trans(l) for l in target_langs))
        
        if user_id not in translations:
            translations[user_id] = {}
            
        for lang, trans in results:
            translations[user_id][lang] = trans
            
        await render_dashboard()
        
    except asyncio.CancelledError:
        pass # A new keystroke cancelled this task
    except Exception as e:
        # Usually happens if someone requests an invalid language like "!lang fwef"
        if user_id not in translations: 
            translations[user_id] = {}
        for l in target_langs:
            translations[user_id][l] = f"[Language Not Found / Error]"
        await render_dashboard()

# ─── SOCKET.IO EVENTS ────────────────────────────────────────────────────────

@sio.event
async def connect():
    print('[+] Connected')
    await sio.emit('join lobby', {'username': 'BabelFish', 'location': 'Translating'})

@sio.on('signin status')
async def on_signin(data):
    global my_user_id
    if data.get('isSignedIn'):
        my_user_id = data['userId']
        print(f"[+] Signed in as {data['username']}")
        print(f"[*] Joining existing room ID '{ROOM_ID}'...")
        await sio.emit('join room', {'roomId': ROOM_ID})

@sio.on('room not found')
async def on_room_not_found():
    print(f"[!] Room {ROOM_ID} was not found! It may have been deleted.")
    sys.exit(1)

@sio.on('room joined')
async def on_room_joined(data):
    print(f"[+] Joined room: {data['roomName']}")
    for u in data.get('users', []):
        users_info[u['id']] = u['username']
    for uid, text in data.get('currentMessages', {}).items():
        user_messages[uid] = text
    await render_dashboard()

@sio.on('user joined')
async def on_user_joined(data):
    users_info[data['id']] = data['username']
    if data['id'] != my_user_id:
        print(f"[+] {data['username']} joined.")
        await render_dashboard()

@sio.on('user left')
async def on_user_left(user_id):
    users_info.pop(user_id, None)
    user_messages.pop(user_id, None)
    user_targets.pop(user_id, None)
    translations.pop(user_id, None)
    if user_id in live_tasks:
        live_tasks[user_id].cancel()
    await render_dashboard()

@sio.on('chat update')
async def on_chat_update(data):
    global user_targets
    user_id = data['userId']
    diff = data['diff']
    
    if user_id == my_user_id:
        return

    # 1. Apply diff to rebuild the live buffer
    msg = user_messages.get(user_id, '')
    if diff['type'] == 'full-replace':
        msg = diff.get('text', '')
    elif diff['type'] == 'add':
        idx = diff['index']
        msg = msg[:idx] + diff['text'] + msg[idx:]
    elif diff['type'] == 'delete':
        idx = diff['index']
        msg = msg[:idx] + msg[idx + diff['count']:]
    elif diff['type'] == 'replace':
        idx = diff['index']
        new_text = diff['text']
        msg = msg[:idx] + new_text + msg[idx + len(new_text):]
    
    user_messages[user_id] = msg
    
    # 2. Parse all commands to see who should be translated
    new_targets = parse_all_commands()
    
    # Check if the requested languages changed for anyone
    targets_changed_for = set()
    for uid in set(new_targets.keys()).union(user_targets.keys()):
        if user_targets.get(uid, set()) != new_targets.get(uid, set()):
            targets_changed_for.add(uid)
            
    user_targets = new_targets
    
    # 3. Figure out who needs their translation updated right now
    # - Anyone whose language targets just changed
    # - The person who just typed (their text changed)
    users_to_update = targets_changed_for.copy()
    users_to_update.add(user_id)
    
    for uid in users_to_update:
        if uid in new_targets:
            clean_text = get_clean_text(user_messages.get(uid, ''))
            
            # Cancel their previous translation request
            if uid in live_tasks and not live_tasks[uid].done():
                live_tasks[uid].cancel()
                
            if not clean_text:
                if uid in translations: 
                    translations[uid].clear()
            else:
                # Setup loading dots for any brand-new languages
                if uid not in translations:
                    translations[uid] = {}
                for l in new_targets[uid]:
                    if l not in translations[uid]:
                        translations[uid][l] = "..."
                        
                # Start the translation!
                live_tasks[uid] = asyncio.create_task(
                    live_translate(uid, clean_text, new_targets[uid])
                )
        else:
            # This user is no longer being translated
            translations.pop(uid, None)
            if uid in live_tasks and not live_tasks[uid].done():
                live_tasks[uid].cancel()
                
    # Force a dashboard render in case commands changed without triggering a translation
    await render_dashboard()

# ─── AFK & ERROR HANDLING ────────────────────────────────────────────────────

@sio.on('afk warning')
async def on_afk_warning(data):
    await sio.emit('afk response') # Keep the bot alive

@sio.on('afk timeout')
async def on_afk_timeout(data):
    print(f"[!] AFK kicked: {data.get('message')}")
    sys.exit(1)

@sio.on('error')
async def on_error(data):
    msg = data.get('error', {}).get('message', data) if isinstance(data, dict) else data
    print(f'[!] Error: {msg}')

@sio.event
async def connect_error(data):
    print(f'[!] Connection error: {data}')

async def main():
    try:
        await sio.connect(SERVER, auth={'token': TOKEN}, transports=['websocket'])
        await sio.wait()
    except asyncio.exceptions.CancelledError:
        pass
    except KeyboardInterrupt:
        print('\n[*] Shutting down...')
        await sio.emit('leave room')
        await sio.disconnect()

if __name__ == '__main__':
    asyncio.run(main())