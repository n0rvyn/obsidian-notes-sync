# Obsidian Notes Sync

This plugin allows you to sync notes between Obsidian and a remote server. It supports:

- Fetching notes from the server
- Creating/updating notes on the server
- Organizing notes in local folders based on tags
- Configurable sync limit

## Installation

1. Download the latest release from the releases page
2. Extract the zip file into your Obsidian plugins folder
3. Enable the plugin in Obsidian settings

## Usage

1. Go to the plugin settings and configure:
   - Bearer Token: Your server authentication token
   - Sync Folder: The local folder where synced notes will be stored
   - Note Fetch Limit: Number of notes to fetch (0 for all)

2. Use the command palette (Ctrl/Cmd + P) and search for:
   - "Sync from Server" to fetch notes from the server
   - "Sync to Server" to push local changes to the server

## Development

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the plugin:
   ```bash
   npm run build
   ```
4. For development with hot-reload:
   ```bash
   npm run dev
   ```

## Features

- Two-way sync between Obsidian and remote server
- Automatic folder organization based on tags
- Front matter preservation for metadata
- Configurable sync limits
- Error handling and notifications

## License

MIT 