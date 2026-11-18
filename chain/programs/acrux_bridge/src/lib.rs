//! The Acrux bridge on Solana. A deposit locks SPL tokens (SPL Token or Token-2022) in the bridge's
//! vault for their mint and writes a deposit record that Acrux's validators read once it is
//! finalized: the Acrux address to credit, the mint and the amount the vault received. Every
//! deposit takes the next sequence number, so a record is credited on Acrux exactly once.
//!
//! It also holds a light client of Acrux: the validator set with its stakes for each Acrux epoch,
//! and the cblocks posted to it. A cblock is certified once validators holding 60% of the stake
//! signed its Finalize vote, or 80% its Notar vote (a fast finalization); Solana's ed25519
//! precompile checks their signatures over the bincode `Vote` in the same transaction. Every
//! cblock carries the next epoch's validator set in its outbox, so any certified cblock of an epoch
//! hands the light client on.
//!
//! The same program runs on Acrux at the same address, where `withdraw` burns a bridged token and
//! records the withdrawal; Acrux writes it into its cblock's outbox, and `release` on Solana pays it
//! out of the vault once that cblock is certified, once per withdrawal.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{hash::hashv, sysvar::instructions as ix_sysvar};
use anchor_spl::token_interface::{burn, transfer_checked, Burn, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("EDm6HxGArNEgGfWRZwvj42f4euc9oPQWVUwUbkK3PEe5");

#[program]
pub mod acrux_bridge {
    use super::*;

    /// Creates the bridge's one state account, which numbers the deposits. Only the program's
    /// upgrade authority can call it, and it becomes the authority that seeds the first validator
    /// set, once; `epoch_slots` is an Acrux epoch's length.
    pub fn initialize(ctx: Context<Initialize>, epoch_slots: u64) -> Result<()> {
        require_upgrade_authority(ctx.accounts.program_data.upgrade_authority_address, ctx.accounts.payer.key())?;
        require!(epoch_slots > 0 && epoch_slots % 4 == 0, BridgeError::BadEpoch);
        ctx.accounts.bridge.set_inner(Bridge { deposits: 0, bump: ctx.bumps.bridge, authority: ctx.accounts.payer.key(), epoch_slots });
        Ok(())
    }

    /// Locks `amount` of the depositor's tokens in the mint's vault and records the deposit for
    /// `recipient` on Acrux. The record holds what the vault received, after any Token-2022
    /// transfer fee.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, recipient: Pubkey) -> Result<()> {
        require!(amount > 0, BridgeError::ZeroAmount);
        let before = ctx.accounts.vault.amount;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        let received = ctx.accounts.vault.amount - before;
        require!(received > 0, BridgeError::ZeroAmount);

        let bridge = &mut ctx.accounts.bridge;
        let sequence = bridge.deposits;
        bridge.deposits += 1;
        let slot = Clock::get()?.slot;
        ctx.accounts.record.set_inner(DepositRecord {
            sequence,
            depositor: ctx.accounts.depositor.key(),
            recipient,
            mint: ctx.accounts.mint.key(),
            amount: received,
            slot,
            bump: ctx.bumps.record,
        });
        emit_cpi!(Deposited { sequence, depositor: ctx.accounts.depositor.key(), recipient, mint: ctx.accounts.mint.key(), amount: received, slot });
        Ok(())
    }

    /// Seeds the light client: Acrux's validators and stakes for `epoch`, in Acrux's validator order.
    /// It works once: the bridge's authority is renounced here, and later sets arrive only through
    /// `hand_off`.
    pub fn init_validator_set(ctx: Context<InitValidatorSet>, epoch: u64, validators: Vec<Validator>) -> Result<()> {
        take_seed_authority(&mut ctx.accounts.bridge.authority, ctx.accounts.authority.key())?;
        require!(!validators.is_empty() && validators.len() <= MAX_VALIDATORS, BridgeError::BadSet);
        let total = validators.iter().map(|v| v.stake).sum();
        ctx.accounts.set.set_inner(ValidatorSet { epoch, total, validators });
        Ok(())
    }

    /// Posts a cblock to be certified, at `["cblock", hash]`. The hash is recomputed here from the
    /// preimage, which starts with the cblock's slot, and the outbox root, so the root is bound to
    /// the hash the validators sign.
    pub fn post_cblock(ctx: Context<PostCblock>, hash: [u8; 32], outbox_root: [u8; 32], preimage: Vec<u8>) -> Result<()> {
        require!(hashv(&[&preimage, &outbox_root]).to_bytes() == hash, BridgeError::BadPreimage);
        let slot = u64::from_le_bytes(preimage.get(..8).ok_or(BridgeError::BadPreimage)?.try_into().unwrap());
        let epoch = slot * 4 / ctx.accounts.bridge.epoch_slots;
        ctx.accounts.cblock.set_inner(Cblock { slot, epoch, hash, outbox_root, notar: 0, finalize: 0, certified: false });
        Ok(())
    }

    /// Counts the votes this transaction's ed25519 instructions verified: each must be a validator
    /// of the cblock's epoch voting Notar or Finalize on its slot and hash.
    pub fn attest_cblock(ctx: Context<AttestCblock>) -> Result<()> {
        let set = &ctx.accounts.set;
        let cblock = &mut ctx.accounts.cblock;
        let sysvar = &ctx.accounts.instructions;
        let current = ix_sysvar::load_current_index_checked(sysvar)? as usize;
        for index in 0..current {
            let ix = ix_sysvar::load_instruction_at_checked(index, sysvar)?;
            if ix.program_id != ED25519_PROGRAM {
                continue;
            }
            for (key, message) in ed25519_entries(&ix.data)? {
                let v = set.validators.iter().position(|x| x.key.to_bytes() == key).ok_or(BridgeError::BadVote)?;
                // bincode Vote: validator (u64), slot (u64), Some (1) and the hash, kind (u32).
                let mut signed = Vec::with_capacity(49);
                signed.extend_from_slice(&(v as u64).to_le_bytes());
                signed.extend_from_slice(&cblock.slot.to_le_bytes());
                signed.push(1);
                signed.extend_from_slice(&cblock.hash);
                require!(message.len() == 53 && message[..49] == signed[..], BridgeError::BadVote);
                match u32::from_le_bytes(message[49..53].try_into().unwrap()) {
                    VOTE_NOTAR => cblock.notar |= 1 << v,
                    VOTE_FINALIZE => cblock.finalize |= 1 << v,
                    _ => return err!(BridgeError::BadVote),
                }
            }
        }
        let stake = |bits: u32| set.validators.iter().enumerate().filter(|(i, _)| bits >> i & 1 == 1).map(|(_, v)| v.stake as u128).sum::<u128>();
        let total = set.total as u128;
        if stake(cblock.finalize) * 100 >= total * 60 || stake(cblock.notar) * 100 >= total * 80 {
            cblock.certified = true;
        }
        Ok(())
    }

    /// On Acrux: burns `amount` of a bridged token (the mint at `["mint", solana_mint]`) and records
    /// the withdrawal to `recipient` on Solana at `["withdrawal", sequence]`, for the cblock's outbox.
    pub fn withdraw(ctx: Context<Withdraw>, solana_mint: Pubkey, amount: u64, recipient: Pubkey) -> Result<()> {
        require!(amount > 0, BridgeError::ZeroAmount);
        burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn { mint: ctx.accounts.mint.to_account_info(), from: ctx.accounts.source.to_account_info(), authority: ctx.accounts.owner.to_account_info() },
            ),
            amount,
        )?;
        let outbound = &mut ctx.accounts.outbound;
        outbound.bump = ctx.bumps.outbound;
        let sequence = outbound.withdrawals;
        outbound.withdrawals += 1;
        ctx.accounts.record.set_inner(Withdrawal {
            sequence,
            owner: ctx.accounts.owner.key(),
            recipient,
            solana_mint,
            amount,
            slot: Clock::get()?.slot,
            bump: ctx.bumps.record,
        });
        Ok(())
    }

    /// On Solana: pays a withdrawal out of the mint's vault to `recipient`'s token account, proven
    /// against the outbox root of a certified cblock. Each sequence is paid once.
    pub fn release(ctx: Context<Release>, sequence: u64, recipient: Pubkey, amount: u64, proof: Vec<ProofNode>) -> Result<()> {
        require!(ctx.accounts.cblock.certified, BridgeError::NotCertified);
        let mint = ctx.accounts.mint.key();
        // bincode OutboxEntry::Withdrawal: variant (u32 1), sequence, Solana mint, recipient, amount.
        let mut entry = Vec::with_capacity(84);
        entry.extend_from_slice(&1u32.to_le_bytes());
        entry.extend_from_slice(&sequence.to_le_bytes());
        entry.extend_from_slice(mint.as_ref());
        entry.extend_from_slice(recipient.as_ref());
        entry.extend_from_slice(&amount.to_le_bytes());
        require!(merkle_root(&entry, &proof) == ctx.accounts.cblock.outbox_root, BridgeError::BadProof);
        let bump = ctx.bumps.vault;
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&[b"vault", mint.as_ref(), &[bump]]],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.released.set_inner(Released { sequence, cblock: ctx.accounts.cblock.key() });
        Ok(())
    }

    /// Hands the light client on to `epoch`: the validator set a certified cblock of the epoch
    /// before carries in its outbox, proven against the outbox root.
    pub fn hand_off(ctx: Context<HandOff>, epoch: u64, validators: Vec<Validator>, proof: Vec<ProofNode>) -> Result<()> {
        let cblock = &ctx.accounts.cblock;
        require!(cblock.certified && cblock.epoch + 1 == epoch, BridgeError::NotCertified);
        require!(!validators.is_empty() && validators.len() <= MAX_VALIDATORS, BridgeError::BadSet);
        // bincode OutboxEntry::ValidatorSet: variant (u32 0), epoch, then the (key, stake) list.
        let mut entry = Vec::with_capacity(20 + validators.len() * 40);
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(&epoch.to_le_bytes());
        entry.extend_from_slice(&(validators.len() as u64).to_le_bytes());
        for v in &validators {
            entry.extend_from_slice(v.key.as_ref());
            entry.extend_from_slice(&v.stake.to_le_bytes());
        }
        require!(merkle_root(&entry, &proof) == cblock.outbox_root, BridgeError::BadProof);
        let total = validators.iter().map(|v| v.stake).sum();
        ctx.accounts.next.set_inner(ValidatorSet { epoch, total, validators });
        Ok(())
    }
}

pub const MAX_VALIDATORS: usize = 32;
const VOTE_NOTAR: u32 = 0;
const VOTE_FINALIZE: u32 = 4;
const ED25519_PROGRAM: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// The outbox root an entry and its proof lead to: the entry's SHA-256, hashed up with each sibling.
fn merkle_root(entry: &[u8], proof: &[ProofNode]) -> [u8; 32] {
    proof.iter().fold(hashv(&[entry]).to_bytes(), |node, step| {
        if step.left { hashv(&[&step.hash, &node]) } else { hashv(&[&node, &step.hash]) }.to_bytes()
    })
}

/// The public key and message of every signature an ed25519 precompile instruction verified,
/// each held in the instruction's own data.
fn ed25519_entries(data: &[u8]) -> Result<Vec<([u8; 32], Vec<u8>)>> {
    let count = *data.first().ok_or(BridgeError::BadVote)? as usize;
    let u16_at = |o: usize| -> Result<usize> { Ok(data.get(o..o + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize).ok_or(BridgeError::BadVote)?) };
    (0..count)
        .map(|i| {
            // Offsets: signature, its instruction, public key, its instruction, message, size, its instruction.
            let o = 2 + i * 14;
            for at in [o + 2, o + 6, o + 12] {
                require!(u16_at(at)? == u16::MAX as usize, BridgeError::BadVote);
            }
            let (key_at, message_at, message_len) = (u16_at(o + 4)?, u16_at(o + 8)?, u16_at(o + 10)?);
            let key: [u8; 32] = data.get(key_at..key_at + 32).ok_or(BridgeError::BadVote)?.try_into().unwrap();
            Ok((key, data.get(message_at..message_at + message_len).ok_or(BridgeError::BadVote)?.to_vec()))
        })
        .collect()
}

#[account]
#[derive(InitSpace)]
pub struct Bridge {
    /// Deposits made so far; the next deposit's sequence number.
    pub deposits: u64,
    pub bump: u8,
    /// Seeds the first validator set, once; renounced (the default key) after it.
    pub authority: Pubkey,
    /// An Acrux epoch's length in slots.
    pub epoch_slots: u64,
}

/// One deposit, at `["deposit", sequence]`.
#[account]
#[derive(InitSpace)]
pub struct DepositRecord {
    pub sequence: u64,
    pub depositor: Pubkey,
    /// The Acrux address the deposit is credited to.
    pub recipient: Pubkey,
    pub mint: Pubkey,
    /// What the vault received, in the mint's base units.
    pub amount: u64,
    /// The Solana slot the deposit landed in.
    pub slot: u64,
    pub bump: u8,
}

/// On Acrux: the withdrawals made so far, at `["outbound"]`.
#[account]
#[derive(InitSpace)]
pub struct Outbound {
    pub withdrawals: u64,
    pub bump: u8,
}

/// On Acrux: one withdrawal, at `["withdrawal", sequence]`.
#[account]
#[derive(InitSpace)]
pub struct Withdrawal {
    pub sequence: u64,
    pub owner: Pubkey,
    /// The Solana address paid out of the vault.
    pub recipient: Pubkey,
    pub solana_mint: Pubkey,
    pub amount: u64,
    /// The Acrux slot of the burn; its cblock's outbox carries the withdrawal.
    pub slot: u64,
    pub bump: u8,
}

/// On Solana: a withdrawal paid, at `["released", sequence]`.
#[account]
#[derive(InitSpace)]
pub struct Released {
    pub sequence: u64,
    pub cblock: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Validator {
    pub key: Pubkey,
    pub stake: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    /// Whether the sibling sits left of the running hash.
    pub left: bool,
    pub hash: [u8; 32],
}

/// Acrux's validators and stakes for one epoch, at `["set", epoch]`.
#[account]
#[derive(InitSpace)]
pub struct ValidatorSet {
    pub epoch: u64,
    pub total: u64,
    #[max_len(32)]
    pub validators: Vec<Validator>,
}

/// A cblock posted to the light client, at `["cblock", hash]`, with the validators that voted for
/// it as bits by their index in the set.
#[account]
#[derive(InitSpace)]
pub struct Cblock {
    pub slot: u64,
    pub epoch: u64,
    pub hash: [u8; 32],
    pub outbox_root: [u8; 32],
    pub notar: u32,
    pub finalize: u32,
    pub certified: bool,
}

/// The program's upgrade authority, and no one else, may initialize the bridge.
fn require_upgrade_authority(upgrade_authority: Option<Pubkey>, signer: Pubkey) -> Result<()> {
    require!(upgrade_authority == Some(signer), BridgeError::NotUpgradeAuthority);
    Ok(())
}

/// Checks `signer` is the bridge's authority, then renounces it (the default key signs nothing), so
/// the validator set is seeded once.
fn take_seed_authority(authority: &mut Pubkey, signer: Pubkey) -> Result<()> {
    require!(*authority != Pubkey::default(), BridgeError::AlreadySeeded);
    require!(*authority == signer, BridgeError::NotUpgradeAuthority);
    *authority = Pubkey::default();
    Ok(())
}

#[event]
pub struct Deposited {
    pub sequence: u64,
    pub depositor: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub slot: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Bridge::INIT_SPACE, seeds = [b"bridge"], bump)]
    pub bridge: Account<'info, Bridge>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ BridgeError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::AcruxBridge>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ BridgeError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [b"bridge"], bump = bridge.bump)]
    pub bridge: Account<'info, Bridge>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = depositor, token::token_program = token_program)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    /// The mint's vault: a token account at `["vault", mint]` that is its own authority, created
    /// by the mint's first deposit.
    #[account(
        init_if_needed,
        payer = depositor,
        seeds = [b"vault", mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = depositor,
        space = 8 + DepositRecord::INIT_SPACE,
        seeds = [b"deposit", bridge.deposits.to_le_bytes().as_ref()],
        bump,
    )]
    pub record: Account<'info, DepositRecord>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct InitValidatorSet<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"bridge"], bump = bridge.bump, has_one = authority)]
    pub bridge: Account<'info, Bridge>,
    #[account(init, payer = authority, space = 8 + ValidatorSet::INIT_SPACE, seeds = [b"set", epoch.to_le_bytes().as_ref()], bump)]
    pub set: Account<'info, ValidatorSet>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(hash: [u8; 32])]
pub struct PostCblock<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"bridge"], bump = bridge.bump)]
    pub bridge: Account<'info, Bridge>,
    #[account(init, payer = payer, space = 8 + Cblock::INIT_SPACE, seeds = [b"cblock", hash.as_ref()], bump)]
    pub cblock: Account<'info, Cblock>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AttestCblock<'info> {
    #[account(mut, seeds = [b"cblock", cblock.hash.as_ref()], bump)]
    pub cblock: Account<'info, Cblock>,
    #[account(seeds = [b"set", cblock.epoch.to_le_bytes().as_ref()], bump)]
    pub set: Account<'info, ValidatorSet>,
    /// CHECK: the instructions sysvar, checked by address.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(solana_mint: Pubkey)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"mint", solana_mint.as_ref()], bump, mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = owner, space = 8 + Outbound::INIT_SPACE, seeds = [b"outbound"], bump)]
    pub outbound: Account<'info, Outbound>,
    #[account(
        init,
        payer = owner,
        space = 8 + Withdrawal::INIT_SPACE,
        seeds = [b"withdrawal", outbound.withdrawals.to_le_bytes().as_ref()],
        bump,
    )]
    pub record: Account<'info, Withdrawal>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sequence: u64, recipient: Pubkey)]
pub struct Release<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"cblock", cblock.hash.as_ref()], bump)]
    pub cblock: Account<'info, Cblock>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump, token::mint = mint, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = recipient, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = payer, space = 8 + Released::INIT_SPACE, seeds = [b"released", sequence.to_le_bytes().as_ref()], bump)]
    pub released: Account<'info, Released>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct HandOff<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"cblock", cblock.hash.as_ref()], bump)]
    pub cblock: Account<'info, Cblock>,
    #[account(init, payer = payer, space = 8 + ValidatorSet::INIT_SPACE, seeds = [b"set", epoch.to_le_bytes().as_ref()], bump)]
    pub next: Account<'info, ValidatorSet>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum BridgeError {
    #[msg("Only the program's upgrade authority can initialize the bridge.")]
    NotUpgradeAuthority,
    #[msg("The validator set was already seeded; the authority is renounced.")]
    AlreadySeeded,
    #[msg("A deposit moves more than nothing.")]
    ZeroAmount,
    #[msg("An epoch is a positive number of cblocks.")]
    BadEpoch,
    #[msg("A validator set holds 1 to 32 validators.")]
    BadSet,
    #[msg("The preimage and outbox root do not hash to the cblock's hash.")]
    BadPreimage,
    #[msg("A signature is not a validator's Notar or Finalize vote on this cblock.")]
    BadVote,
    #[msg("The cblock is not certified in the epoch before the set it hands on.")]
    NotCertified,
    #[msg("The validator set is not in the cblock's outbox.")]
    BadProof,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_err(result: Result<()>, name: &str) -> bool {
        match result {
            Err(e) => format!("{e:?}").contains(name),
            Ok(()) => false,
        }
    }

    #[test]
    fn initialize_by_a_non_authority_is_rejected() {
        let authority = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        assert!(is_err(require_upgrade_authority(Some(authority), stranger), "NotUpgradeAuthority"));
    }

    #[test]
    fn initialize_on_a_program_without_an_upgrade_authority_is_rejected() {
        assert!(is_err(require_upgrade_authority(None, Pubkey::new_unique()), "NotUpgradeAuthority"));
    }

    #[test]
    fn initialize_by_the_upgrade_authority_works() {
        let authority = Pubkey::new_unique();
        assert!(require_upgrade_authority(Some(authority), authority).is_ok());
    }

    #[test]
    fn the_authority_seeds_once_then_cannot_reseed() {
        let authority = Pubkey::new_unique();
        let mut stored = authority;
        assert!(take_seed_authority(&mut stored, authority).is_ok());
        assert_eq!(stored, Pubkey::default());
        assert!(is_err(take_seed_authority(&mut stored, authority), "AlreadySeeded"));
        assert!(is_err(take_seed_authority(&mut stored, Pubkey::default()), "AlreadySeeded"));
    }

    #[test]
    fn a_stranger_cannot_seed_and_does_not_burn_the_authority() {
        let authority = Pubkey::new_unique();
        let mut stored = authority;
        assert!(is_err(take_seed_authority(&mut stored, Pubkey::new_unique()), "NotUpgradeAuthority"));
        assert_eq!(stored, authority);
        assert!(take_seed_authority(&mut stored, authority).is_ok());
    }
}
