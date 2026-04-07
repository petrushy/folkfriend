export class HistoryItem {
    constructor(result) {
        this.result = result;
        this.timestamp = Date.now();
    }
}

export class FavouriteItem {
    constructor(result, folderId = null) {
        this.result = result; // { settingID, setting, displayName }
        this.timestamp = Date.now();
        this.folderId = folderId;
    }
}

export class FavouriteFolder {
    constructor({ id, name, createdAt } = {}) {
        this.id = id || (Date.now().toString(36) + Math.random().toString(36).slice(2));
        this.name = name || new Date().toISOString().slice(0, 10);
        this.createdAt = createdAt || Date.now();
    }
}
