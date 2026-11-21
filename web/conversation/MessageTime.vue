<script setup lang="ts">
import {computed} from 'vue';
import {messageTime} from './messageTime';
const props=defineProps<{value?:string}>();const time=computed(()=>messageTime(props.value));
</script>
<template><time v-if="time" class="message-time" :datetime="time.dateTime" :title="time.full">{{time.label}}</time></template>
<style scoped>.message-time{flex:none;color:var(--fg-subtlest);font:400 12px/20px var(--font-ui);font-variant-numeric:tabular-nums;white-space:nowrap}</style>
