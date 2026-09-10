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
        <p v-if="sessionId" class="caption mb-1" role="status">{{ label }}</p>
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
import { dropboxState, backupStatus, connectDropbox, disconnectDropbox, syncDropbox, restoreDropboxSessions,
    deleteDropboxCopy, deleteLocalCopy, enableSessionBackup } from '@/services/dropbox.js';
export default {
    name: 'DropboxBackup',
    props: { sessionId: { type: String, default: '' }, active: { type: Boolean, default: false } },
    data: () => ({ state: dropboxState, busy: false, error: '', message: '' }),
    computed: { label() { return backupStatus(this.sessionId); } },
    methods: {
        disconnect: disconnectDropbox,
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
