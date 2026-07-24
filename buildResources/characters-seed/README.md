# Adding your own character pack

Create a folder here (next to this README) named after your character, containing:

- `spritesheet.webp` — a sprite sheet image.
- `pet.json` — a TexturePacker-style atlas. It must define these animation states: `idle`, `walk`, `alert`, `tired`, `thinking`, `celebrate`, `talking`. `typing` and `working` are optional.

For example:

```
characters/
  my-character/
    spritesheet.webp
    pet.json
```

Restart Founder Pet and your character will show up as a new option in the tray menu's "Pets" submenu.
