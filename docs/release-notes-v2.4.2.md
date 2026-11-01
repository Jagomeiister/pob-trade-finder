## v2.4.2: fixes for the app over the game, and a better character compare

- **Shift+Space (app over the game)**: the window no longer flips back to its old size or
  frame, and clicking in the game puts it away every time, not only after a resize.
- **Compare with character** now checks every place an item can be:
  - a jewel counts wherever it is socketed in your tree, not only in the build's socket
    (your tree jewels are read in the same click);
  - a ring counts in either ring slot;
  - "Upgrades only" compares against the item it actually matched.
- The Skill tree's **Compare with my character** reuses the data from that click, without
  asking the site again.
