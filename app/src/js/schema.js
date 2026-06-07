export class HistoryItem {
    constructor(result) {
        this.result = result;
        this.timestamp = Date.now();
    }
}

export class FavouriteItem {
    constructor(result) {
        this.result = result; // { settingID, setting, displayName }
        this.timestamp = Date.now();
        this.tags = []; // string[] — user-defined tags, e.g. ['to practice', 'tuesday session']
    }
}
