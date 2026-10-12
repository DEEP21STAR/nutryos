# Meal photo fixtures: sources and licences

All photos are from Wikimedia Commons, licence **CC0 1.0 (public domain dedication)** as reported by the
Commons API (`extmetadata.LicenseShortName` = `CC0`). No Google Images. Files here are the 960 px thumbnails
Commons serves (`thumburl`), downloaded 2026-10-10, unmodified apart from Commons' own resizing.
Licence deed for every file: <http://creativecommons.org/publicdomain/zero/1.0/deed.en>

| File here | Commons page (file URL) | Original file URL | Author (as listed) | Licence |
|---|---|---|---|---|
| 01-full-english-breakfast.jpg | https://commons.wikimedia.org/wiki/File:Full_English_breakfast_-_London,_UK.jpg | https://upload.wikimedia.org/wikipedia/commons/0/05/Full_English_breakfast_-_London%2C_UK.jpg | Daderot | CC0 |
| 02-chicken-fried-rice-peas.jpg | https://commons.wikimedia.org/wiki/File:Chicken_breast,_roasted_with_garlic_olive_oil_and_black_pepper,_on_fried_rice_and_peas_with_soy_sauce_-_Massachusetts.jpg | https://upload.wikimedia.org/wikipedia/commons/9/9c/Chicken_breast%2C_roasted_with_garlic_olive_oil_and_black_pepper%2C_on_fried_rice_and_peas_with_soy_sauce_-_Massachusetts.jpg | Daderot | CC0 |
| 03-meatloaf-plate.jpg | https://commons.wikimedia.org/wiki/File:Meatloaf_on_white_plate.jpg | https://upload.wikimedia.org/wikipedia/commons/3/36/Meatloaf_on_white_plate.jpg | Roundhere44 | CC0 |
| 04-rice-and-chicken-lunch.jpg | https://commons.wikimedia.org/wiki/File:Rice_and_chicken_served_for_lunch.jpg | https://upload.wikimedia.org/wikipedia/commons/8/8c/Rice_and_chicken_served_for_lunch.jpg | Nambogo Catharine | CC0 |
| 05-american-chop-suey.jpg | https://commons.wikimedia.org/wiki/File:American_Chop_Suey_on_White_Plate.jpg | https://upload.wikimedia.org/wikipedia/commons/4/41/American_Chop_Suey_on_White_Plate.jpg | Roundhere44 | CC0 |
| 06-egg-sandwich-salad.jpg | https://commons.wikimedia.org/wiki/File:Brioche_bun_egg_breakfast_sandwich_with_salad.jpg | https://upload.wikimedia.org/wikipedia/commons/6/68/Brioche_bun_egg_breakfast_sandwich_with_salad.jpg | Thegreatmutata | CC0 |
| 07-single-banana.jpg (extra: the single-item photo for the tap-count test) | https://commons.wikimedia.org/wiki/File:Banana_-_Q503.jpg | https://upload.wikimedia.org/wikipedia/commons/f/f4/Banana_-_Q503.jpg | Sandra Fauconnier | CC0 |

## What these are used for

UI and upload flow, layout at 390x844, and the merge/fix logic. `responses.json` holds, per photo, what the author
could SEE (`known`) and a hand-written **simulated** edge-function response. Nothing here measures how well a real
vision model recognises these plates or estimates their kcal; that is UNPROVEN until the Phase 4 edge function is
deployed and run against real Gemini.
