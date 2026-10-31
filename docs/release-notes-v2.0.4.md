## v2.0.4: build diff, daily build tracking, wide screens, price gaps

**Loading a newer version of a build**
- Paste an updated PoB of the same build and a **Changed since the version you loaded…**
  list appears above the gear: what changed in each slot (the item, or the mod lines added
  and removed), what it cost when you last priced the old version, and, after **Price
  changed slots**, what it costs now and the difference.
- Changed slots are marked in the slot list, and unchanged slots keep their cost history.

**Daily price tracking for saved builds**
- Press **📈** on a saved build: re-price it once a day, with an optional alert when it
  costs at or under a price. It re-runs your last search for each slot you priced, slowly
  and never during a rate-limit cooldown. The card shows the latest total and the change.

**Wide screens**
- On very wide windows (ultrawide), item pages use the extra room and a priced item shows
  its listings beside its mods instead of below them.

**Market: chaos ↔ divine price gaps**
- Items that traded against both chaos and divines last hour at noticeably different
  prices, with which way round was cheaper and how much traded (2,000c an hour or more by
  default). These are last hour's averages: check the live exchange before trading.

**Fewer wasted trade calls**
- A unique or gem whose art lookup fails for good (unknown name, nothing ever listed) is no
  longer looked up again on every launch; it's retried after a week.

**Under the hood**
- The app's main script is split into 16 smaller files, and a new end-to-end test suite
  (11 scenarios in headless Chrome) runs the real interface before every release.
