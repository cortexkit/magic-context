//! The memory lifecycle shared with the TypeScript host: its named limits, its text rules,
//! the ownership predicate that decides which side may write a project's memories, and the
//! module's applier.

pub mod applier;
pub mod authority;
pub mod constants;
pub mod text;

#[cfg(test)]
mod tests;
