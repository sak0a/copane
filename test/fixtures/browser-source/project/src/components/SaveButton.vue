<script setup>
// The save button of the editor toolbar.
defineProps({ busy: Boolean });
const emit = defineEmits(['save']);

function save() {
  emit('save');
}
</script>

<template>
  <div class="save">
    <span class="hint">Ctrl+S</span>
    <button id="save" :disabled="busy" @click="save">Save</button>
  </div>
</template>
