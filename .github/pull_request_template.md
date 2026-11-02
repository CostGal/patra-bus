If you can't fill these in your own words, the PR isn't ready.

## Task / Εργασία
<!-- TEL-<id> από την κάρτα του Notion (ποτέ με το χέρι) και σύνδεσμος στην κάρτα. Branch: <ποιος γράφει τον κώδικα>/TEL-<id>-<slug>. Αν υπάρχει issue: Closes #N. Δες docs/WORKFLOW.md. -->
TEL-

## Τι άλλαξε / What changed
<!-- 2–5 κουκκίδες: τι και γιατί. Ανέφερε αν αγγίζει worker (deploy μόνο από τον Kostas μετά το merge). -->
-

## Γιατί / Why
<!-- Required. In your own words: what problem does this solve? -->

## Πώς μπορεί να σπάσει / How it could break / how to undo
<!-- Required. In your own words: what could go wrong, and how do we undo it (revert the PR? something else)? -->

## Screenshots (κινητό / mobile)
<!-- Αν αλλάζει UI: light + dark, πριν / μετά. Αλλιώς γράψε N/A. -->

| | Πριν / Before | Μετά / After |
|---|---|---|
| Light | | |
| Dark | | |

## UI protocol
<!-- Μόνο αν αλλάζει κάτι που φαίνεται στην οθόνη (docs/UI-PROTOCOL.md). Αλλιώς γράψε N/A. -->
- [ ] Κανόνες U1… του docs/UI-PROTOCOL.md: ισχύουν για ό,τι αγγίζει το PR, ή εξαίρεση εδώ με τον λόγο:
- [ ] Καμία νέα διάσταση, inset ή χρώμα όπου υπάρχει κλάση του kit ή token
- [ ] `npm run shots` (low / mid / up × light / dark × EL / EN) και ονόματα από το UI map
- [ ] Έλεγχοι στο iPhone ως issue `device-test`: #

## Πώς ελέγχθηκε / How tested
<!-- Τσέκαρε ό,τι έκανες. Demo: http://localhost:8080/?demo#/stop/1011 (ή το preview του PR με ?demo). -->
- [ ] `npm test`
- [ ] `npm run check:i18n`
- [ ] Σε πραγματικό κινητό / on a real mobile device, ή issues `device-test` για ό,τι μένει (CLAUDE.md κανόνας 9): #
- [ ] Demo URL (`?demo`)
- [ ] Ελληνικά και αγγλικά / EL and EN both checked
