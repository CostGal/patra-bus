/** Μία κάρτα της βάσης Tasks· τα προαιρετικά λείπουν όταν το πεδίο είναι κενό στο Notion. */
export type Card = {
  id: number
  title: string
  status: string
  url: string
  area?: string
  who?: string
  due?: string
  pr?: string
}
/** Το τρέχον sprint: όνομα, ημερομηνίες, οι ανοιχτές κάρτες και πόσες είναι ήδη Done. */
export type Sprint = {
  cards: Card[]
  name?: string
  start?: string
  end?: string
  done?: number
  error?: string
  updatedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'tel-sprint': { sprint: Sprint }
  }
}
