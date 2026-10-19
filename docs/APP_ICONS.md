# App Icons

| Application | Master PNG | Platform icon prefix | Entry |
| --- | --- | --- | --- |
| Headquarters | `/assets/headquarters-icon.png` | `/icons/headquarters-` | `/headquarters` |
| Ginjiro SB | `/assets/sb-icon.png` | `/icons/sb-` | `/sb` |
| Store terminal | `/assets/staff-icon.png` | `/icons/staff-` | `/staff` |

The headquarters artwork is the silver J, SB is the metallic calendar, and the store terminal is the red scanner.
Each application uses its own manifest, favicon and Apple touch icon. Each pack contains 32/192/512px PNGs,
a 180px Apple touch icon and a 512px maskable icon. Customer app artwork is unchanged.

The original icon commit was reapplied to the latest Staging while preserving the updated terminal UI
and the SB child route in StaffPinGate. SB now uses its own artwork in the shared PIN gate as well.

Validate with `node --test scripts/app-icons.test.mjs`.
Installed home-screen icon refresh still requires a real-device check.
