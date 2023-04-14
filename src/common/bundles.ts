import { Transfer } from "../../generated/schema"

const a = (t: Transfer[]): boolean => { return false }
const b = (t: Transfer[]): boolean => { return false }

export let BundleCriteria = new Array<(transfers: Transfer[]) => boolean>();
BundleCriteria.push(a)
BundleCriteria.push(b)
