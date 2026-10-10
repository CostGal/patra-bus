// Greek source string -> English for platform.js / install-guide.js (install-as-app tutorial). Same rules as i18n-en.js: keys are EXACTLY the Greek
// text passed to t(), {name} placeholders must match, keep UI English short. Merged into EN by i18n-en.js.
// Already in i18n-en.js and reused as is: «Εγκατάσταση», «Ο σύνδεσμος αντιγράφηκε».
export const PAIRS = [
  ['Εγκατάσταση ως εφαρμογή', 'Install as an app'],
  ['Εγκατάστησε το {app}', 'Install {app}'],
  ['Πρόσθεσε το {app} στην αρχική οθόνη', 'Add {app} to your home screen'],
  ['Η εφαρμογή είναι εγκατεστημένη. Δεν χρειάζεται κάτι άλλο.', 'The app is installed. Nothing else to do.'],
  ['Εγκαταστάθηκε! Βρες την στην αρχική οθόνη ή στη λίστα εφαρμογών.', 'Installed! Find it on your home screen or in your app list.'],
  ['Ανοίγει σε πλήρη οθόνη, με ένα πάτημα από την αρχική οθόνη.', 'Opens full screen, one tap from your home screen.'],
  ['Ανοίγει σε πλήρη οθόνη, με ένα πάτημα. Στο iPhone, οι υπενθυμίσεις με ειδοποίηση δουλεύουν μόνο στην εγκατεστημένη εφαρμογή.', 'Opens full screen, one tap away. On iPhone, reminders with notifications only work in the installed app.'],
  // iOS
  ['Πάτησε «Κοινοποίηση»', 'Tap “Share”'],
  ['Πάτησε «Κοινοποίηση» ή το μενού του προγράμματος περιήγησης', 'Tap “Share” or the browser menu'],
  ['Στο iPhone είναι κάτω ή μέσα στο μενού «⋯», στο iPad πάνω.', 'On iPhone it is at the bottom or inside the “⋯” menu, on iPad at the top.'],
  ['Διάλεξε «Προσθήκη στην οθόνη Αφετηρίας»', 'Choose “Add to Home Screen”'],
  ['Αν δεν φαίνεται, σύρε τη λίστα προς τα πάνω.', 'If you do not see it, scroll the list up.'],
  ['Πάτησε «Προσθήκη»', 'Tap “Add”'],
  ['Δεν βλέπεις «Προσθήκη στην οθόνη Αφετηρίας»; Άνοιξε τη σελίδα στο Safari και ακολούθησε τα ίδια βήματα.', 'Do not see “Add to Home Screen”? Open the page in Safari and follow the same steps.'],
  // in-app browsers
  ['Άνοιξε τη σελίδα στο Safari', 'Open the page in Safari'],
  ['Άνοιξε τη σελίδα στο Chrome', 'Open the page in Chrome'],
  ['Αυτή η σελίδα άνοιξε μέσα σε άλλη εφαρμογή, που δεν επιτρέπει εγκατάσταση.', 'This page opened inside another app, which cannot install apps.'],
  ['Άνοιξε το μενού της εφαρμογής και διάλεξε «Άνοιγμα στο Safari»', 'Open the app menu and choose “Open in Safari”'],
  ['Άνοιξε το μενού της εφαρμογής και διάλεξε «Άνοιγμα στο Chrome»', 'Open the app menu and choose “Open in Chrome”'],
  ['Ή αντίγραψε τον σύνδεσμο και επικόλλησέ τον στο Safari', 'Or copy the link and paste it in Safari'],
  ['Ή αντίγραψε τον σύνδεσμο και επικόλλησέ τον στο Chrome', 'Or copy the link and paste it in Chrome'],
  ['Εκεί θα δεις τα βήματα εγκατάστασης.', 'There you will see the install steps.'],
  ['Αντιγραφή συνδέσμου', 'Copy link'],
  ['Σύνδεσμος της σελίδας', 'Page link'],
  ['Επίλεξε και αντίγραψε τον σύνδεσμο', 'Select and copy the link'],
  // Android
  ['Πάτησε το μενού', 'Tap the menu'],
  ['Διάλεξε «Εγκατάσταση εφαρμογής» ή «Προσθήκη στην αρχική οθόνη»', 'Choose “Install app” or “Add to Home screen”'],
  ['Διάλεξε «Προσθήκη στο τηλέφωνο» ή «Εγκατάσταση»', 'Choose “Add to phone” or “Install”'],
  ['Επιβεβαίωσε την εγκατάσταση', 'Confirm the installation'],
  ['Πάτησε το μενού (κάτω δεξιά)', 'Tap the menu (bottom right)'],
  ['Διάλεξε «Προσθήκη σελίδας σε» και μετά «Αρχική οθόνη»', 'Choose “Add page to”, then “Home screen”'],
  ['Διάλεξε «Εγκατάσταση»', 'Choose “Install”'],
  // desktop
  ['Στον υπολογιστή: ψάξε το εικονίδιο εγκατάστασης στη γραμμή διευθύνσεων ή απλώς κράτα τη σελίδα στους σελιδοδείκτες.', 'On a computer: look for the install icon in the address bar, or just bookmark the page.'],
];
