# Music bed slot

Drop a single track here named `music.<ext>` (e.g. `music.mp3`) and
`assemble.sh` will loop it under the narration at 12% volume. No file — no
music; the cut still renders with narration only.

Suggested free tracks — grab one from [mixkit.co/free-stock-music](https://mixkit.co/free-stock-music/)
(Mixkit license allows use in videos without attribution). Calm tech/corporate
beds work best under spoken narration; try searching for:

1. "Tech House Vibes"
2. "Serene View"
3. "Dreaming Big"

Then:

```bash
mv ~/Downloads/<track>.mp3 assets/music.mp3
```

Nothing in this directory except this README is committed (see `.gitignore`).
