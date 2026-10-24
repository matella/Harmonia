# Store listing drafts

Drafts for the product owner to edit. They describe what the release build does today. Partner sharing is off in release builds (`SYNC_CONFIG` is null), so it isn't mentioned; a paragraph to add when it ships is at the end. Each store gets its own platform's wording (Apple's guideline 2.3.10: no mention of other platforms), so the watch line differs. Limits: Google Play title 30, short description 80, full description 4000 characters; App Store name 30, subtitle 30, keywords 100. "Harmonia" is a working title (BRANDING.md).

## English

- **Title / name:** Harmonia: Our Time Together
- **Play short description:** A private counter for your relationship, with dates, memories and widgets.
- **App Store subtitle:** Your days together, privately
- **Keywords (App Store):** couple,relationship,anniversary,days together,love counter,countdown,memories,widget

**Full description**

Harmonia counts the time you've shared and keeps the dates that matter in view.

- See how long you've been together in years, months and days, or in total days.
- Keep your anniversary, first date and other moments as dates, once or every year, with discreet reminders the day before.
- Save memories with a note and photos.
- Put your counter on your home screen with widgets, and on your watch. *(Google Play: "and on your Wear OS watch." App Store: "and on your Apple Watch.")*
- Use it in English, French or Dutch.

Private by design: there's no account and no tracking. Everything stays on your phone. Lock the app with your phone's own unlock, export everything as a ZIP file, or delete it all at any time.

## Français

- **Titre :** Harmonia : notre temps à deux
- **Description courte (Play) :** Un compteur privé pour votre couple, avec dates, souvenirs et widgets.
- **Sous-titre (App Store) :** Vos jours ensemble, en privé
- **Mots-clés :** couple,relation,anniversaire,jours ensemble,compteur amour,compte à rebours,souvenirs,widget

**Description complète**

Harmonia compte le temps que vous avez partagé et garde en vue les dates qui comptent.

- Voyez depuis combien de temps vous êtes ensemble, en années, mois et jours, ou en jours au total.
- Gardez votre anniversaire, votre premier rendez-vous et d'autres moments, une fois ou chaque année, avec des rappels discrets la veille.
- Enregistrez des souvenirs avec une note et des photos.
- Affichez votre compteur sur l'écran d'accueil avec des widgets, et sur votre montre. *(Google Play : « et sur votre montre Wear OS. » App Store : « et sur votre Apple Watch. »)*
- En français, en anglais ou en néerlandais.

Privé par conception : pas de compte, aucun suivi. Tout reste sur votre téléphone. Verrouillez l'app avec le déverrouillage de votre téléphone, exportez tout en fichier ZIP, ou supprimez tout à tout moment.

## Nederlands

- **Titel:** Harmonia: onze tijd samen
- **Korte beschrijving (Play):** Een privételler voor je relatie, met datums, herinneringen en widgets.
- **Ondertitel (App Store):** Jullie dagen samen, privé
- **Trefwoorden:** koppel,relatie,jubileum,dagen samen,liefdesteller,aftellen,herinneringen,widget

**Volledige beschrijving**

Harmonia telt de tijd die jullie samen hebben en houdt de datums die ertoe doen in beeld.

- Zie hoe lang jullie samen zijn, in jaren, maanden en dagen, of in dagen in totaal.
- Bewaar jullie jubileum, eerste date en andere momenten, één keer of elk jaar, met discrete herinneringen de dag ervoor.
- Bewaar herinneringen met een notitie en foto's.
- Zet je teller op je startscherm met widgets, en op je horloge. *(Google Play: "en op je Wear OS-horloge." App Store: "en op je Apple Watch.")*
- In het Nederlands, Engels of Frans.

Privé vanaf het begin: geen account, geen tracking. Alles blijft op je telefoon. Vergrendel de app met de ontgrendeling van je telefoon, exporteer alles als zip-bestand, of wis alles wanneer je wilt.

## Data disclosures (release build as it is today)

- **Google Play Data safety:** no data collected, no data shared. Data is stored on the device; the user can delete it in the app (Settings › Privacy and data › Delete all data).
- **App Store privacy label:** Data Not Collected.
- If usage sharing ships (`USAGE_CONFIG` set): see RELEASE_CHECKLIST.md › Usage analytics.

## When partner sharing ships

Add to the full description (EN; translate likewise): "Share with your partner: both of you see the same dates and memories, photos included. What you share is end-to-end encrypted; the sharing server can't read it." The disclosures change too: the server receives encrypted content and the metadata in PARTNER_SYNC.md §10, so the Data safety form and the privacy label need redoing, and a privacy policy URL is required.

## Screenshots

Not made yet. Use an invented couple and dates, shown as examples, never presented as real people: phone (Home, Dates, a memory, widgets) and the watch.
