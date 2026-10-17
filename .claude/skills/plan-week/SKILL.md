---
name: plan-week
description: Εβδομαδιαίο planning του Telematica (patra-bus). Μαζεύει τις ανοιχτές κάρτες του Notion, τα GitHub issues και τα PRs, βρίσκει τι λείπει, προτείνει τα 3–5 tasks της επόμενης εβδομάδας και κάνει όλες τις ερωτήσεις μαζί. Χρήση όταν ο χρήστης γράψει /plan-week ή ζητήσει planning της εβδομάδας.
---

Ακολούθησε το `docs/WORKFLOW.md`: ενότητα «`/plan-week`» για τη ροή, ενότητες 1 και 3 για τους κανόνες. Απάντα στα
ελληνικά. Σε αυτό το session **δεν γράφεται κώδικας**.

Πηγές:
- Notion, βάση Tasks: data source `collection://4da2abc0-511d-4dfb-b9c5-180656a8f5e2`, κάρτες με
  Project = Telematica (`https://app.notion.com/p/515a54a507ec4922a7aa1386664028be`) και `Task status` ≠ Done.
  Δομή, views και άλλες σελίδες δεν αλλάζουν.
- GitHub `CostGal/patra-bus`: ανοιχτά issues (με labels) και ανοιχτά PRs (draft, CI, mergeable).

Ροή:
1. Μάζεψε και διασταύρωσε: issue χωρίς κάρτα, κάρτα με κλειστό issue ή merged PR που δεν είναι Done, διπλά,
   In progress / In review χωρίς κίνηση, PRs που περιμένουν merge, `device-test` issues, αποφάσεις του Kostas.
2. Δείξε σύντομη λίστα ανά ομάδα (ένα στοιχείο ανά γραμμή: TEL-id, #issue, τίτλος, ποιος).
3. Πρότεινε 3–5 tasks για την επόμενη εβδομάδα με τον λόγο για το καθένα. Μόνο μία εβδομάδα μπροστά.
4. Όλες οι ερωτήσεις μαζί, αριθμημένες, και σταμάτα.
5. Μετά την απάντηση: ενημέρωσε τις κάρτες (Sprint, Who does this), φτιάξε όσες έλειπαν, και δώσε τη λίστα της εβδομάδας
   με σειρά και την εντολή για το πρώτο task (`/task TEL-<id>`).
