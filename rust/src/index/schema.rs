use serde::{Deserialize, Deserializer, Serialize};
use std::collections;

pub type TuneSettings = collections::HashMap<SettingID, Setting>;
pub type TuneAliases = collections::HashMap<TuneID, Vec<SettingID>>;

// These are very deliberately strings of integers.
//   Otherwise rust / wasm / serde / etc. problems.
pub type TuneID = String;
pub type SettingID = String;

/// Deserialize a field that may be missing OR explicitly null as an empty String.
fn null_as_empty_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Setting {
    pub tune_id: TuneID,
    pub meter: String,
    pub mode: String,
    pub abc: String,
    pub dance: String,
    pub contour: String,
    #[serde(default, deserialize_with = "null_as_empty_string")]
    pub origin: String,
    #[serde(default, deserialize_with = "null_as_empty_string")]
    pub composer: String,
}
