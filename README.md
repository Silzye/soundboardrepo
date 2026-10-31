# Soundboard

A soundboard app with virtual mic routing for Discord, YouTube clip importing, and AI voice conversion (RVC).

## Requirements

**To use the app** you need nothing but the installer, plus:

* [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) — required for routing sounds into Discord (or any other app) as a virtual microphone (free)
* (Optional, for **AI Voices** only) [Python 3](https://www.python.org/downloads/) — or let the app download one for you on Windows

**To build it from source** you need:

* [Rust](https://rustup.rs) (stable)
* [Node.js](https://nodejs.org/) 22 from nodejs.org (a copy of this binary is bundled as the app's background service)
* Linux only: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`

## Building from source

```
npm install
npm start          # dev build (npm run dev does the same)
npm run build      # installers in src-tauri/target/release/bundle
```

First time only, see [MIGRATION.md](MIGRATION.md) (icons and the updater signing key).

## Setup for Discord (Virtual Mic)

This app can route sounds directly into your Discord mic so others in a voice channel can hear them.

1. Install **VB-Audio Virtual Cable** from https://vb-audio.com/Cable/
2. Restart your PC after installing
3. Open the soundboard, click the **Settings** gear icon, and go to the **Audio** tab
4. Set **Virtual Mic Device** to **CABLE Input**
5. In Discord: go to **Settings → Voice & Video → Input Device** and set it to **CABLE Output**
6. Done — sounds you play will be heard by others in your voice channel, mixed with your real mic if you enable that too

## First-run setup guide

On a fresh install, a short guide checks for the virtual audio cable, plays a test tone, and offers the optional extras (YouTube import tool, AI Voices). You can skip it, and reopen it any time from **Settings → System → Run setup guide again**.

If you install VB-Audio Cable while the app is open, it is detected automatically and connected as the virtual mic when none was chosen, so no restart of the app is needed.

## Getting help

**Settings → System → Copy diagnostics** copies a report (versions, setup status, settings, recent errors) to your clipboard for bug reports. Your home folder path is masked and no cookies are included. Errors are also logged to `soundboard.log` in the app's data folder.

## Usage

### Adding & playing sounds

* Click **Add Sounds** to import audio files (MP3, WAV, OGG, FLAC, M4A, AAC, Opus, WebM, AIFF)
* Click a sound card to play it, click again to stop
* Use the search bar and category filter at the top to find sounds quickly
* Click the pencil icon on a card to edit it:
  * Rename it, change its category, emoji, and color
  * Set a **global hotkey** (works even when the app is minimized/in the background)
  * Adjust per-sound **volume**, **fade in/out**
  * Apply pitch/formant shifting or an **AI voice** conversion (see below)
  * Choose whether the sound also plays through your virtual mic
* Click the trash/reveal icons to delete a sound or show its file in your file explorer

### Playback controls

* **Master Volume** — overall output volume
* **Virtual Mic Volume** — how loud sounds are when routed into Discord
* **Stop All Sounds** button stops everything at once
* Toggles available in the main toolbar:
  * **Stop on overlap** — automatically stops any currently playing sound when you play a new one
  * **Loop** — loops the currently played sound until stopped
  * **Queue mode** — queues sounds instead of playing them simultaneously

### Mic mixer (Audio settings)

Open **Settings → Audio** to configure:

* **Output Device**, **Virtual Mic Device**, and **Mic Input Device** — pick which physical/virtual devices the app uses
* **Mic Volume** and a live input meter
* **Local monitor** — hear your own mic through your speakers/headphones
* **Monitor mic feed** — hear the combined mic + soundboard mix locally
* **Mic FX** — apply effects to your live mic
* **Noise gate** — mute your mic below a set volume threshold, with an adjustable threshold
* **Ducking** — automatically lower music/sound volume while you talk
* **Push-to-talk mode** — mic is only live while a key is held

### AI Voices (RVC)

Convert a sound clip's audio to sound like one of your installed AI voice models before it plays:

1. Go to **Settings → AI Voices** and click **Install/Update Backend** to set up the required Python packages (`rvc-python`, `demucs`) automatically — or install Python yourself first if it isn't found
2. Add voice model files (`.pth`, optionally with a matching `.index`) via **Add Voices**, or drop them straight into the app's `rvc_voices` folder (openable from the same tab)
3. On a sound's edit screen, pick a voice, adjust pitch, and optionally enable **Separate vocals** (isolates vocals before conversion and remixes them with the original instrumental afterward — slower, but keeps background music/effects clean)
4. Click **Preview** to hear it, or **Save** to apply it — converted audio is cached so it only needs to run once per sound/voice/pitch combination

This runs conversion locally on your machine via Python; the first conversion of a clip can take a while (longer with vocal separation), especially without a GPU. This is separate from any real-time voice-changer app — this feature converts pre-recorded sound clips, not your live mic.

### Importing clips from YouTube

1. Click the YouTube import button, paste a video URL, and click **Fetch**
2. Optionally set a start/end time to trim the clip, and enable **auto-trim** to strip silence from the start/end
3. Click **Import** to download and add it as a sound

The app downloads a small helper tool (`yt-dlp`) automatically the first time you use this — no manual install needed. If a video fails to import with a "sign in to confirm you're not a bot" or age-restriction error, go to the YouTube import settings and either:
* Import a `cookies.txt` file exported from your browser while signed in to YouTube, or
* Point the app at a browser you're signed in to and let it read cookies from there directly

Cookies are stored locally and only ever handed to the download tool — they aren't sent anywhere else.

### Live Voice Changer

The **Live Voice** page has two modes:

* **Instant effects** — your mic runs through a real-time pitch shifter and the same 40 voice presets used on sounds, plus an extra pitch slider. Everything runs inside the app with a delay of roughly 5–15 ms from the shifter itself and needs no Python or GPU. Presets and pitch can be changed while you're live.
  * The shifter tracks the pitch of your voice and makes every splice on a whole number of voice cycles, then fine-tunes it by waveform matching, so it avoids most of the warble of a basic shifter. Speech with clear pitch sounds best; whispers and noisy rooms fall back to a simpler mode.
  * Voices are grouped: **Pitch & age** (Deep, Male, Female, Child, Baby, Chipmunk, Helium, Old Man, Giant, Ogre), **Creatures & characters** (Demon, Monster, Zombie, Dark Lord, Alien, Fairy, Cartoon, Nasal, Announcer), **Robots & radio** (Robot, Cyborg, Telephone, Radio, Walkie-Talkie, Megaphone, Lo-Fi), **Spaces & atmosphere** (Echo, Ghost, Haunted, Underwater, Cave, Cathedral, Bathroom, Stadium) and **Singing & mood** (Choir, Opera, Drunk, Scared, Whisper).
* **AI voice (RVC)** — converts your voice to an installed AI voice model. This needs the AI Voices backend and has a few seconds of delay.

Either way, the changed voice is what goes out through your virtual mic.

## Hotkeys

Hotkeys are global and work even when the app is minimized.

To set a hotkey:

1. Click the pencil icon on a sound card
2. Click the hotkey field
3. Press your desired key combination (e.g. `Ctrl+Shift+1`)
4. Click Save (or click the clear button to remove it)

## Notes

* **Settings → Appearance → Low-power visuals** turns off blur and background animation to keep the app light on older computers. It switches on automatically on low-spec machines and can be changed at any time
* All your sounds, settings, and window position are saved automatically and reloaded next time you launch the app
* Everything (sound library, settings, imported clips, downloaded tools, voice models) is stored locally in the app's own data folder (`%APPDATA%\\Soundboard`, `~/Library/Application Support/Soundboard`, or `~/.config/Soundboard`) — nothing is uploaded anywhere
