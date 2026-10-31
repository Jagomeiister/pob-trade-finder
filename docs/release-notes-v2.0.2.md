## v2.0.2: new-league banner, price alerts

**New league? One click**
- The app checks GGG's league list when it starts and every 6 hours. When a new challenge
  league goes live, a banner offers **Switch to <league>**: it refreshes the trade data,
  moves every search and price to the new league, and reloads. **Not now** hides it for
  that league.

**Price alerts (Market)**
- Press **🔔 Alert** above any item's chart: *rises above* or *falls below* a price (chaos
  or divine), or *moves more than X% in 24 hours*.
- Checked each hour while the app is open. Each alert fires once when the price crosses
  the level and again only after it has crossed back. You get an in-app message with a
  **View** button, plus a Windows notification when the app is in the background.
- Items with an alert join your watchlist and show 🔔 there.

**Fixes**
- The converter reads "Worth 371 chaos" instead of starting with a stray "=", and no
  longer repeats the currency you typed in or shows tiny divine fractions.
- **Install & restart** into this version should no longer show the ".NET unhandled
  exception" box (the fix shipped in 2.0.1; this is the first update that runs it).
