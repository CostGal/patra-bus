/** Μία κάρτα της βάσης Code Tasks· τα προαιρετικά λείπουν όταν το πεδίο είναι κενό στο Notion. */
export type Card = {
  id: number
  title: string
  status: string
  url: string
  area?: string
  pr?: string
  /** In progress / In review πάνω από 7 μέρες από το Started on. */
  stuck?: boolean
}
/** Τα τρέχοντα blocks (Κατάσταση = Τρέχον, ένα ή δύο): όνομα («B0 · … + B0.5 · …»), οι ανοιχτές κάρτες και πόσες είναι ήδη Done. */
export type Block = {
  cards: Card[]
  name?: string
  done?: number
  error?: string
  updatedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'tel-sprint': { block: Block }
  }
}
