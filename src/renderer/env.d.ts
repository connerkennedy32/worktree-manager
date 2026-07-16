import type { Api } from '@shared/ipc-types'
declare global { interface Window { api: Api } }
export {}
