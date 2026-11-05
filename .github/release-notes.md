## Install

You don't need Node.js, npm, the source code or a terminal.

1. Under **Assets** below, download **InterviewPilot-AI-Setup-x.y.z.exe** (about 610 MB). You don't need the "Source code" files.
2. Double-click it. The installer isn't code-signed yet, so Windows may say "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Follow the installer. Choosing "Only for me" needs no administrator rights.
4. Start **InterviewPilot AI** from the Start menu or your desktop.

**Requires** Windows 10 (version 2004 or newer) or Windows 11, 64-bit, and about 1 GB of disk space.

## First launch

A short setup takes you through choosing your AI and checking speech recognition. Speech-to-text works straight away. For AI answers, choose one:

- **Groq Cloud AI (recommended):** fast, high-quality answers over the internet, using your own Groq account and API key (steps below). Your questions, recent transcript and resume are sent to Groq; your audio stays on your PC.
- **Ollama Local AI:** private, and works offline. The app shows you how to install the free Ollama program and download a 4.7 GB AI model. Needs about 6 GB of free memory while answering.

You only need one of them, and you don't need Ollama if you choose Groq. You can skip this and finish later in Settings › AI model, where you can also switch at any time.

## Get your Groq API key

An API key is like a long password that lets the app use your own Groq account. Getting one takes a couple of minutes, and you only do it once.

1. In the app's setup, click **Open the Groq console**. If you skipped the setup, go to [console.groq.com/keys](https://console.groq.com/keys) in your browser.
2. Click **Log In**. If you're new to Groq, create a free account.
3. Click **Create API Key**. If it asks for a name, type anything, such as `InterviewPilot`.
4. Copy the key, which starts with `gsk_`. Do it straight away, as you may not be able to see it again. If you lose it, just create a new one.
5. Go back to InterviewPilot AI, click the key box and press **Ctrl+V**. Right-clicking won't offer Paste. The app's window stays on top, so if it covers the Groq page, drag it aside by its title bar.
6. Click **Save and test**. When you see "Connected to Groq", you're done.

If you skipped the setup, the same key box is in Settings › AI model, with *Online (Groq)* selected as the provider.

Your key is stored encrypted on your PC and only ever sent to Groq. Each person needs their own key: don't share yours with anyone. If someone else gets it, remove it in the Groq console and create a new one.

## Good to know

- The window has no taskbar button, by design. Press **Ctrl+Shift+Space** to show or hide it, or start the app again from the Start menu.
- If the microphone doesn't work: Windows Settings › Privacy & security › Microphone › turn on *Let desktop apps access your microphone*.

## Update or uninstall

- **Update:** run the newer installer. Your AI provider, key, settings and history are kept.
- **Uninstall:** Windows Settings › Apps › Installed apps › InterviewPilot AI › Uninstall. Your settings, key and history stay in `%APPDATA%\InterviewPilot AI`. Delete that folder to remove them too.
