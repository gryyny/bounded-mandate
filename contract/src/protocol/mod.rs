//! External protocol adapters: NEP-413 encoding, MPC signer, reference oracle and Intents verifier
//! interfaces. Pure functions and `ext_contract` interfaces only; no state and no policy.

pub mod gas;
pub mod mpc;
pub mod nep413;
pub mod oracle;
pub mod verifier;

use core::fmt;

/// A malformed or unsupported value at a protocol boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    /// A response or argument did not decode as the pinned interface specifies.
    Malformed(&'static str),
    /// A key or signature on a curve other than Ed25519.
    UnsupportedCurve,
    /// An order the verifier would reject or misread: zero/oversized amount, same token on both
    /// sides, or a deadline outside the encodable range.
    InvalidOrder(&'static str),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(what) => write!(f, "malformed {what}"),
            Self::UnsupportedCurve => f.write_str("unsupported curve: ed25519 required"),
            Self::InvalidOrder(why) => write!(f, "invalid order: {why}"),
        }
    }
}

impl std::error::Error for ProtocolError {}
