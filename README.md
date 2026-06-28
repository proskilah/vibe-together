# VibeTogether

Listen to music together with friends in real-time. Synchronize playback across multiple Spotify clients using P2P technology.

## Features

- ðŸŽµ **Real-time synchronization** - All participants hear the same music at the same time
- ðŸ‘¥ **Session management** - Create sessions or join with a code
- ðŸ”’ **Owner-only mode** - Control who can change tracks
- ðŸ”„ **Manual sync** - Force synchronization if needed
- ðŸŽ›ï¸ **Playback controls** - Play, pause, skip, previous
- ðŸ“± **Draggable panel** - Move the UI anywhere on screen
- ðŸ’¾ **Position memory** - Remembers panel position

## Installation

### Via Spicetify Marketplace

1. Open Spicetify Marketplace in Spotify
2. Search for "VibeTogether"
3. Click Install

### Manual Installation

1. Copy `vibeTogether.js` to your Spicetify extensions folder:
   - **Windows**: `%appdata%\spicetify\Extensions\`
   - **Linux**: `~/.config/spicetify/Extensions/`
   - **macOS**: `~/.config/spicetify/Extensions/` or `~/.spicetify/Extensions/`

2. Run:
   ```bash
   spicetify config extensions vibeTogether.js
   spicetify apply
   ```

3. Restart Spotify

## Usage

1. Click the **VibeTogether** button in Spotify's top bar (people icon)
2. **Create a session**: Click "Create Session" and share the code with friends
3. **Join a session**: Enter a friend's code and click "Join"
4. **Control playback**: Use the controls in the session panel
5. **Owner-only mode**: As host, enable this to restrict track changes

## Requirements

- Spotify Desktop (Windows, macOS, or Linux)
- Spicetify v2.0 or higher
- Internet connection (for P2P signaling)

## How it works

VibeTogether uses PeerJS for P2P connections with a free signaling server. When you create a session, you become the host and control playback. When friends join, they receive your playback state and synchronize automatically.

## Troubleshooting

- **Can't connect**: Check your internet connection
- **Desynced**: Click "Manual Sync" in the session panel
- **Panel not showing**: Make sure the extension is enabled in Spicetify config
- **Code invalid**: Ask your friend for the correct session code

## Credits

- Based on [CoListen](https://github.com/CharlieS1103/spicetify-plugins) extension
- Uses [PeerJS](https://peerjs.com/) for P2P connections
- VibeCodeadas Extension

## License

MIT License
