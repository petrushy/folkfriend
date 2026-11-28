<template>
    <v-container class="viewContainerWrapper">
        <h1 class="my-2">
            Donate to the original FolkFriend
        </h1>
        <v-card class="pa-5 my-2">
            <p>
                FolkFriend was created by <strong>Tom Wyllie</strong>, who built the
                transcription and tune search at its heart and published it as open source.
            </p>
            <p>
                The version you are using has since been developed further by others,
                adding things like offline multi-database search, sessions with plans and
                capture, sets and places. That work is not what this page funds.
            </p>
            <p>
                <strong>A donation from here goes to the original FolkFriend project</strong>,
                through its own donation page. It opens in a new tab.
            </p>
            <v-btn
                color="primary"
                depressed
                href="https://donorbox.org/help-support-development-of-folkfriend"
                target="_blank"
                rel="noopener noreferrer"
            >
                <v-icon left>
                    {{ icons.heart }}
                </v-icon>
                Donate to the original FolkFriend
            </v-btn>
            <p class="caption text--secondary mt-4 mb-0">
                More about who made what is on the <router-link :to="{ name: 'help' }">About</router-link> page.
            </p>
        </v-card>
    </v-container>
</template>

<script>
import { mdiHeart } from '@mdi/js';
import eventBus from '@/eventBus.js';

// A page before the donation link, so it is clear where the money goes: to
// the original app's author, not to the people who developed this version.
export default {
    name: 'DonateView',
    data: () => ({ icons: { heart: mdiHeart } }),
    created() {
        eventBus.$emit('parentViewActivated');
    },
};
</script>
