//! Close IndexedDB connections when their owning operation finishes.

use std::ops::Deref;

use indexed_db_futures::database::Database;

/// An owned IndexedDB connection that closes on drop, including error paths.
pub struct DatabaseConnection(Database);

impl DatabaseConnection {
    pub(crate) fn new(database: Database) -> Self {
        Self(database)
    }
}

impl Deref for DatabaseConnection {
    type Target = Database;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for DatabaseConnection {
    fn drop(&mut self) {
        self.0.clone().close();
    }
}
