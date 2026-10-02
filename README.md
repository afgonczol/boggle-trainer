# Boggle Trainer

A practice tool for the Netflix Boggle game (Boggle Party): play 4×4, 5×5 or 6×6 boards by swiping with a mouse or finger, then see every word you missed, ranked by what is most worth learning.

## Features
- Swipe input (mouse or touch), timer, 3–5 letter minimum, sound effects
- After each game: all missed words, with the path shown on the board (hover or click), plus definitions via Wiktionary
- **Learn** tab: priority list, word families, form/length patterns, missed letter combinations, rejected swipes
- Rejected-swipe tracking, with one-tap "misswipe" removal
- Practice mode (header toggle): play without touching your stats
- Profiles: separate stats per person on a shared device
- Enter a real Netflix board by hand, then play it or log which words you found
- Works offline once loaded; installable on a phone ("Add to Home Screen")

## Using it
Open the hosted page, or run it locally:

```
node serve.js        # then open http://localhost:8080
```

`index.html` also works when opened directly from disk. All stats live in your browser's localStorage on your own device; nothing is uploaded. Use Tools → Export/Import to move data between devices.

## Rebuilding the word data
`node build-words.js` regenerates `words.js` and `roots.js` from `data/`.

## Credits
- Word list: ENABLE (public domain)
- Inflection pairs: [michmech/lemmatization-lists](https://github.com/michmech/lemmatization-lists) (Open Database License)
- Definitions: Wiktionary REST API
- Not affiliated with Netflix or Hasbro. Boggle is a trademark of Hasbro.
