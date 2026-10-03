# HCMCx atlas

Register: Console for a map explorer, with a readable text data section.
Design read: The city occupies the screen; compact controls expose the layers and source evidence without hiding the skyline.
Reference: The 1972 Vignelli New York subway diagram, for the separation of schematic routes from geographic detail.
Dominant element: the interactive city map; the data section is a supporting source ledger.
Line weights: 2 px for keyboard focus and station rings, 1 px for controls, dashed lines for reference-area outlines.

Amber is the sole interface accent. Map colors are a load-bearing exception: water, transit, air-quality categories, and sensor status need distinct geographic symbols. They are not interface accents. Status is also written in text, so color is never its only carrier. Gradients are not used in interface swatches.

Maturity: public demo. Buildings are an Overture snapshot with mixed height sources. Flood areas and the metro alignment are indicative reference geometry. Air quality is modeled Open-Meteo / CAMS data. VNTT records may be stale; bus positions may be simulated. Neither map color nor the experimental risk API establishes on-street safety.

## Vietnamese material themes — 3 October 2026

At the user's request, the interface uses Palette's source-verified Wada plate 325: Eugenia Red | B #da525d, Naples Yellow #fbe6a0, Yellow Ocher #e2b540, Deep Slate Green #112f2c. This overrides the default amber interface rule for this atlas only. The Wada chord is Japanese; the Vietnamese association is our contemporary reading of lacquer, yellow plaster, and shaded green woodwork. Reference: Hội An Ancient Town's yellow façades, documented by its World Heritage centre at https://hoianworldheritage.org.vn/en/news/Hoi-An-Travel/a-bewitching-town-drenched-in-yellow-450.hwh.

Dark: deep green dominates, ochre marks actions, pale yellow carries text. Light: yellow paper dominates, deep green carries text, a darkened Eugenia Red marks actions. High contrast: deeper green and near-white maximize value separation, with bright ochre for actions. Derived shades are adaptations for contrast, not source swatches. The city remains the dominant element; equal decorative color fields would compete with it. Alert colors retain their geographic meaning. All three themes share the same layout, controls and content.

Human task: a visitor on a phone explores a place, checks the source of a height or feed, and chooses a reading condition. Conserved: buildings, landmarks, waterways, transit, flood areas, AQI, quick jump, inspection, flyover and orbit. Chosen composition: dominant city with compact controls and a source ledger below. Rejected: a full-viewport color exhibition, which would displace the city. Uninstructed human taste/field testing remains unverified.
