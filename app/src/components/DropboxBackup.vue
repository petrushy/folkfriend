<template>
    <div class="dropboxBackup">
        <h3 class="text-subtitle-1">Dropbox audio storage</h3>
        <p v-if="!sessionId" class="caption text--secondary">
            Firebase keeps your sessions, tune lists, favourites and other account data in sync
            across devices signed into the same FolkFriend account. Dropbox adds storage for recordings,
            using space in your own Dropbox account. Audio uploads directly to Dropbox.
        </p>
        <p v-if="!sessionId" class="caption text--secondary">
            On each device, sign into the same FolkFriend account and connect the same Dropbox account.
            Open your synced sessions as usual to play their recordings. Each device needs its own
            Dropbox authorization; connecting Dropbox does not change your FolkFriend account sync.
        </p>
        <p v-if="!sessionId" class="caption text--secondary">
            Connecting enables audio backup for all existing and future recordings on this device.
            A recovery copy of session names, locations and tune lists is saved beside the audio.
            Originals stay on this device until you explicitly delete them.
            Uploads continue while FolkFriend is open and resume after you return online.
        </p>
        <div v-if="!sessionId && state.enabled" class="mb-4" aria-live="polite">
            <p v-if="state.storage.storedBytes !== null" class="mb-1">
                <strong>{{ formatBytes(state.storage.storedBytes) }} stored by FolkFriend on Dropbox</strong>
            </p>
            <p v-else class="mb-1">{{ state.storage.loading ? 'Checking Dropbox storage…' : 'Dropbox storage usage unavailable' }}</p>
            <p v-if="state.storage.availableBytes !== null" class="caption mb-1">
                {{ formatBytes(state.storage.availableBytes) }} available in your Dropbox account
            </p>
            <p v-else-if="state.storage.quotaState === 'permission'" class="caption mb-1">
                Allow Dropbox account information to show available space.
            </p>
            <p v-else-if="state.storage.checkedAt" class="caption mb-1">Available space could not be determined.</p>
            <p v-if="state.storage.checkedAt" class="caption text--secondary mb-1">
                Last checked {{ new Date(state.storage.checkedAt).toLocaleTimeString() }}.
                Stored size includes recordings and recovery files in FolkFriend’s Dropbox folder.
            </p>
            <p v-if="state.storage.error" class="caption error--text">{{ state.storage.error }}</p>
            <v-btn small text :loading="state.storage.loading" :disabled="!state.connected" @click="refreshStorage(true)">Refresh storage usage</v-btn>
            <v-btn v-if="state.storage.quotaState === 'permission'" small text :disabled="!state.connected" :loading="busy" @click="allowSpaceUsage">Show available space</v-btn>
        </div>
        <div v-if="!sessionId && state.enabled" class="mb-3">
            <v-switch
                :input-value="state.wholeRecordings"
                :disabled="!state.connected || busy"
                inset
                dense
                hide-details
                class="mt-0"
                label="Also save each finished session as one playable file"
                @change="setWhole"
            />
            <p class="caption text--secondary mb-0">
                Puts a complete recording in <strong>/recordings</strong>, named by date and place, so
                you can open it in any player. It is a second copy, so a session takes about twice the
                Dropbox space, and it is uploaded once the session is finished — not while you are still
                listening. A session paused part-way saves one file per stretch.
            </p>
        </div>
        <p v-if="sessionId" class="caption mb-1" role="status">{{ label }}</p>

        <!-- A newer copy in Dropbox. The refusal used to say "restore or review
             that copy", and nothing in the app could do either: "Recover
             missing sessions" deliberately skips a session that already exists
             here, so unless Firebase happened to deliver the newer version the
             Retry button could never succeed. This is that missing half. -->
        <v-alert v-if="sessionId && conflictMessage" type="warning" dense text class="mb-2">
            {{ conflictMessage }}
            <div v-if="!conflict" class="mt-2">
                <v-btn small text :loading="busy" :disabled="!state.connected" @click="reviewConflict">
                    Compare the two copies
                </v-btn>
            </div>
            <template v-else>
                <table class="conflictTable caption mt-2">
                    <tr>
                        <th />
                        <th>This device</th>
                        <th>Dropbox</th>
                    </tr>
                    <tr>
                        <td>Name</td>
                        <td>{{ copyField('name') }}</td>
                        <td>{{ copyField('name', true) }}</td>
                    </tr>
                    <tr>
                        <td>Tunes</td>
                        <td>{{ copyField('tunes') }}</td>
                        <td>{{ copyField('tunes', true) }}</td>
                    </tr>
                    <tr>
                        <td>Last edited</td>
                        <td>{{ editedAt(conflict.local) }}</td>
                        <td>{{ editedAt(conflict.remote) }}</td>
                    </tr>
                </table>
                <p class="caption text--secondary mt-2 mb-1">
                    Whichever you keep becomes this session everywhere: it is saved here and
                    synced to your other devices. The audio is not affected either way.
                </p>
                <div class="d-flex flex-wrap" style="gap: 8px;">
                    <v-btn small color="primary" :loading="busy" @click="keepCopy('local')">
                        Keep this device's version
                    </v-btn>
                    <v-btn small text :loading="busy" @click="keepCopy('remote')">
                        Use the Dropbox version
                    </v-btn>
                </div>
            </template>
        </v-alert>
        <p v-if="!state.configured" class="caption">Dropbox backup has not been configured for this installation.</p>
        <v-alert v-if="error || state.error" dense text type="warning">{{ error || state.error }}</v-alert>
        <p v-if="message" class="caption" role="status">{{ message }}</p>
        <div class="d-flex flex-wrap" style="gap: 8px;">
            <v-btn v-if="!state.connected" small color="primary" :disabled="!state.configured" :loading="busy" @click="connect">
                {{ state.enabled ? 'Reconnect Dropbox' : 'Connect Dropbox' }}
            </v-btn>
            <template v-if="state.enabled">
                <v-btn small text :loading="state.busy" :disabled="!state.connected" @click="run(retry)">Retry backup</v-btn>
                <v-btn v-if="!sessionId" small text :disabled="!state.connected" :loading="busy" @click="restore">Recover missing sessions</v-btn>
                <v-btn v-if="!sessionId" small text @click="run(disconnect)">Disconnect Dropbox</v-btn>
                <v-btn v-if="sessionId" small text color="error" :disabled="active || !state.connected" @click="removeCloud">Delete Dropbox copy</v-btn>
            </template>
            <v-btn v-if="sessionId" small text color="error" :disabled="active" @click="removeLocal">Delete local audio</v-btn>
        </div>
        <p v-if="state.enabled && !sessionId" class="caption text--secondary mt-2 mb-0">
            Sessions normally appear through Firebase account sync. Recover missing sessions only
            if a session record was lost; it is not needed to listen on another device.
        </p>
        <p v-if="sessionId" class="caption text--secondary mt-2 mb-0">
            Firebase syncs this session’s tune list. Connect the same Dropbox account on your other
            devices to play its audio.

            Local audio and the Dropbox copy are deleted separately. Recently played Dropbox audio is cached when space allows.
        </p>
    </div>
</template>
<script>
import { dropboxState, backupStatus, connectDropbox, disconnectDropbox, syncDropbox, restoreDropboxSessions, setWholeRecordings,
    deleteDropboxCopy, deleteLocalCopy, enableSessionBackup, refreshDropboxStorage, sessionConflictMessage, sessionConflict, resolveSessionConflict } from '@/services/dropbox.js';
import { formatBytes } from '@/services/sessionAudioStore.js';
export default {
    name: 'DropboxBackup',
    props: { sessionId: { type: String, default: '' }, active: { type: Boolean, default: false } },
    data: () => ({ state: dropboxState, busy: false, error: '', message: '', conflict: null }),
    computed: {
        label() { return backupStatus(this.sessionId); },
        conflictMessage() { return this.sessionId ? sessionConflictMessage(this.sessionId) : ''; },
    },
    watch: {
        // A conflict that has gone (settled here, or resolved by the device
        // that held the newer copy pushing it through Firebase) must take its
        // comparison table with it.
        conflictMessage(value) { if (!value) this.conflict = null; },
        sessionId() { this.conflict = null; },
        'state.connected'() { this.refreshStorage(); },
        'state.revision'() { this.refreshStorage(); },
    },
    mounted() {
        this.refreshStorage();
        this._storageTimer = setInterval(() => { if (!document.hidden) this.refreshStorage(); }, 60000);
    },
    beforeDestroy() { clearInterval(this._storageTimer); },
    methods: {
        formatBytes,
        copyField(field, remote = false) {
            const copy = remote ? this.conflict.remote : this.conflict.local;
            if (!copy) return 'not there';
            return copy[field] === '' ? '(unnamed)' : copy[field];
        },
        editedAt(copy) {
            if (!copy) return 'not there';
            return copy.updatedAt ? new Date(copy.updatedAt).toLocaleString() : 'unknown';
        },
        reviewConflict() {
            return this.run(async () => { this.conflict = await sessionConflict(this.sessionId); });
        },
        keepCopy(which) {
            if (which === 'remote' && !window.confirm('Replace this session\u2019s tune list and details with the Dropbox copy? The version on this device will be overwritten, on your other devices too.')) return;
            return this.run(async () => {
                await resolveSessionConflict(this.sessionId, which);
                this.conflict = null;
            });
        },
        refreshStorage(force = false) { if (!this.sessionId) return refreshDropboxStorage(force); },
        allowSpaceUsage() { return this.run(async () => {
            await connectDropbox({ includeSpaceUsage: true });
            await this.refreshStorage(true);
        }); },
        disconnect: disconnectDropbox,
        // Turning it on re-runs the backup, so sessions already in Dropbox get
        // their whole-file copy rather than waiting for something else to
        // change. Turning it off leaves existing files alone — deleting a
        // recording is always an explicit act.
        setWhole(value) { return this.run(() => setWholeRecordings(value)); },
        retry() { return this.sessionId ? enableSessionBackup(this.sessionId) : syncDropbox(true); },
        async run(action) {
            this.busy = true; this.error = ''; this.message = '';
            try { await action(); } catch (e) { this.error = e.message; }
            finally { this.busy = false; }
        },
        connect() {
            if (!this.state.enabled && !window.confirm('Use your Dropbox storage for all existing and future recordings on this device? Room audio and a recovery copy of session names, locations and tune lists will upload to your Dropbox App Folder while FolkFriend is open. Firebase continues to sync your FolkFriend account. Connect the same Dropbox account on your other devices to play the audio.')) return;
            return this.run(connectDropbox);
        },
        restore() { return this.run(async () => { const n = await restoreDropboxSessions(); this.message = `Restored ${n} missing sessions. Open them in Past Sessions.`; }); },
        removeCloud() {
            if (!window.confirm('Delete this session’s Dropbox copy? Its local audio and tune list will remain. Automatic backup for this session will stop until you choose Retry backup.')) return;
            return this.run(() => deleteDropboxCopy(this.sessionId));
        },
        removeLocal() {
            if (!window.confirm('Delete this session’s local audio? If it has not been backed up, the audio cannot be recovered. Its tune list and any Dropbox copy will remain.')) return;
            return this.run(() => deleteLocalCopy(this.sessionId));
        },
    },
};
</script>
<style scoped>
.conflictTable {
    border-collapse: collapse;
}
.conflictTable th,
.conflictTable td {
    text-align: left;
    padding: 2px 12px 2px 0;
    vertical-align: top;
}
</style>
