# UCDP Explorer

An interactive map of the Uppsala Conflict Data Program's Georeferenced Event Dataset (GED), 1989 to 2026. Filter by location (region, country, first- and second-level division) and conflict, choose dates on the timeline, and use Box select to filter to a box drawn on the map. Filters zoom the map and timeline to their events; the timeline also zooms with the wheel and pans by dragging, and dragging a handle while zoomed in first snaps the dates to the part in view. The Deadliest events column lists the top events under the filters; hover one to ring it on the map, or click to fly there. Settings switch fatality figures between the best estimate and UCDP's low–high range, and color points by type of violence. Each event's size comes from UCDP's best estimate of deaths, and the legend shows the scale.

## Branches and releases

- `dev` is the default branch. Feature branches start from `dev` and merge back into it by pull request.
- `main` is production. Every push to `main` builds the app and deploys it to GitHub Pages (see `.github/workflows/deploy-pages.yml`).
- To release, open a pull request from `dev` into `main` and merge it.

## Run the app

Requires Node 20 or later. The processed data is in the repo, so this is all you need:

```bash
npm install
npm run dev
```

## How it works

- **Data:** `public/data/events.bin` stores 12 bytes per event for the GPU: Equal Earth position, first and last day, and deaths. `public/data/attrs.bin` stores each event's division, conflict, actor and country ids for filtering, plus its type of violence. `public/data/details.bin` holds the low and high death estimates and a place id into `public/data/places.json`; both load after the map, since only totals in Range mode and the event list need them. `public/data/meta.json` holds the names behind the ids and the month list. Events are sorted by start date.
- **Projection:** positions are projected to Equal Earth when the data is built, so the browser only scales them.
- **Rendering:** a small WebGL2 renderer in `src/renderer.ts` adds every event into a density buffer, then turns density into light with a two-size glow. A point's area grows with its deaths.
- **Filtering:** the location and conflict filters run on the CPU and upload one byte per event: 0 if filtered out, else the event's type of violence, which colors it when type colors are on. Dates and the box are checked on the GPU, so dragging the timeline doesn't re-upload anything.
- **Dates:** an event shows for every day from its start to its end date. The timeline moves a month at a time.
- **Fatalities:** the totals, the dropdown numbers and the event list use UCDP's best estimate of deaths, or the low–high range when Range is on. The timeline chart, point sizes and sort orders always use the best estimate. Where UCDP's low is above its best or its high below it, `prep_data.py` widens the range to take in the best. The chart shares an event's deaths across the months it runs through, by days. Dropdowns hide anything with no events under the current filters.
- **Outlines:** country outlines come from Natural Earth's 1:50m countries, projected to Equal Earth in `public/data/outlines.bin`.
- **Provisional data:** 2026 events come from UCDP's monthly candidate release and are flagged as provisional in `attrs.bin`.

## Rebuild the data

The source CSVs are too large for GitHub, so they aren't in the repo. Put `GEDEvent_v26_1.csv` and `GEDEvent_v26_01_26_09.csv` from [UCDP downloads](https://ucdp.uu.se/downloads/) in `raw-data/`. The script needs Python with pandas.

```bash
python scripts/prep_data.py
```

The country outlines need Python with pyshp:

```bash
python scripts/build_outlines.py
```
