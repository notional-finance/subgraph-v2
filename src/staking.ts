import { StakedNoteChange } from '../generated/schema';
import { SNoteMinted, SNoteRedeemed } from '../generated/StakedNote/sNOTE';

export function handleSNoteMinted(event: SNoteMinted): void {
    let accountId = event.params.account.toHexString();
    let change = StakedNoteChange.load(accountId);
    if (change == null) {
        change = new StakedNoteChange(accountId)
    }

    change.timestamp = event.block.timestamp.toI32();
    change.wethAmount = event.params.wethChangeAmount;
    change.noteAmount = event.params.noteChangeAmount;
    change.bptAmount = event.params.bptChangeAmount;
    change.save();
}

export function handleSNoteRedeemed(event: SNoteRedeemed): void {
    let accountId = event.params.account.toHexString();
    let change = StakedNoteChange.load(accountId);
    if (change == null) {
        change = new StakedNoteChange(accountId)
    }

    change.timestamp = event.block.timestamp.toI32();
    change.wethAmount = event.params.wethChangeAmount.neg();
    change.noteAmount = event.params.noteChangeAmount.neg();
    change.bptAmount = event.params.bptChangeAmount.neg();
    change.save();
}
