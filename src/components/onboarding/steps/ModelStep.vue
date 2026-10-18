<template>
  <div class="ob-group-title">{{ t('onboarding.model.pick') }}</div>
  <div class="ob-row">
    <button
      v-for="option in METHOD_OPTIONS"
      :key="option.id"
      type="button"
      class="ob-chip"
      :class="{ 'is-active': settingsStore.authMethod === option.id }"
      :disabled="option.oauth"
      @click="selectMethod(option.id)"
    >
      <span class="ob-chip-dot" :style="{ background: option.color }" />
      {{ option.name }}
      <span v-if="option.oauth" class="ob-chip-note">OAuth</span>
    </button>
  </div>
  <p class="ob-hint ob-hint--warn">{{ t('onboarding.model.oauthTip') }}</p>

  <template v-if="!isOAuthMethod">
    <div class="ob-group-title">{{ t('onboarding.model.vendor') }}</div>
    <div class="ob-grid ob-grid--2">
      <div>
        <span class="ob-label">{{ t('onboarding.model.vendor') }}</span>
        <select class="ob-select" :value="presetIndex" @change="selectPreset(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="(preset, index) in presets" :key="preset.id" :value="index">
            {{ preset.name }}{{ preset.badgeType ? ' · ' + t(badgeKey(preset.badgeType)) : '' }}
          </option>
        </select>
      </div>
      <div>
        <span class="ob-label">{{ t('auth.baseUrl') }}</span>
        <input class="ob-input is-mono" :value="activeConfig.baseUrl" spellcheck="false" :placeholder="defaultBaseUrlOf(settingsStore.authMethod)" @change="commitBaseUrl">
      </div>
    </div>

    <div class="key-block">
      <span class="ob-label">{{ t('auth.apiKey') }}</span>
      <div class="ob-key-field">
        <input
          class="ob-input is-mono"
          :type="showKey ? 'text' : 'password'"
          :value="activeConfig.apiKey"
          spellcheck="false"
          @change="commitApiKey"
        >
        <button type="button" class="ob-eye" @click="showKey = !showKey">
          <EyeOff v-if="showKey" :size="13" />
          <Eye v-else :size="13" />
        </button>
      </div>
      <p class="ob-hint">{{ t('onboarding.model.keyTip') }}</p>
    </div>

    <div class="ob-row test-row">
      <button type="button" class="ob-btn ob-btn--ghost ob-btn--sm" :disabled="probing" @click="runTest">
        {{ t('onboarding.model.test') }}
      </button>
      <span class="ob-endpoint">GET {{ endpointPath }}</span>
      <span class="state" :class="ready ? 'is-ok' : 'is-pending'">
        {{ ready ? t('onboarding.model.configured') : t('onboarding.model.notConfigured') }}
      </span>
    </div>

    <div v-if="probing" class="ob-status ob-status--load">
      <Loader2 :size="13" class="spin" />{{ t('onboarding.model.testing') }}
    </div>
    <div v-else-if="probeMessage" class="ob-status" :class="probeOk ? 'ob-status--ok' : 'ob-status--err'">
      <Check v-if="probeOk" :size="13" :stroke-width="2.6" />
      <AlertTriangle v-else :size="13" />
      {{ probeMessage }}
    </div>

    <div class="ob-group-title">{{ t('onboarding.model.slots') }}</div>
    <div v-for="slot in SLOTS" :key="slot.key" class="ob-slot">
      <span>{{ t(slot.labelKey) }}</span>
      <input
        class="ob-input is-mono"
        :list="modelIds.length ? MODEL_DATALIST_ID : undefined"
        :value="activeConfig[slot.key]"
        spellcheck="false"
        @change="commitSlot(slot.key, ($event.target as HTMLInputElement).value)"
      >
    </div>
    <datalist v-if="modelIds.length" :id="MODEL_DATALIST_ID">
      <option v-for="id in modelIds" :key="id" :value="id" />
    </datalist>
    <p class="ob-hint">{{ t('onboarding.model.slotNote') }}</p>
  </template>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Check, Eye, EyeOff, Loader2 } from 'lucide-vue-next'
import { useSettingsStore, type AuthMethod, type ProviderConfig } from '@/stores/settings'
import { PROVIDER_PRESETS } from '@/lib/providerPresets'
import { OAUTH_METHODS, defaultBaseUrlOf, probeEndpoint, resolveEndpoint } from '@/lib/providerConnection'
import type { ProbeOutcome } from '@/lib/providerConnection'
import { normalizeApiUrl } from '@/utils/apiUrl'

const { t } = useI18n()
const settingsStore = useSettingsStore()

const METHOD_OPTIONS: ReadonlyArray<{ id: AuthMethod; name: string; color: string; oauth: boolean }> = [
  { id: 'anthropic_compatible', name: 'Anthropic', color: '#d97757', oauth: false },
  { id: 'openai_compatible', name: 'OpenAI', color: '#10a37f', oauth: false },
  { id: 'gemini_api', name: 'Gemini', color: '#4285f4', oauth: false },
  { id: 'claudeai', name: 'Claude', color: '#cc785c', oauth: true },
  { id: 'console', name: 'Console', color: '#5c5f7a', oauth: true }
]

const SLOTS: ReadonlyArray<{ key: 'haikuModel' | 'sonnetModel' | 'opusModel'; labelKey: string }> = [
  { key: 'sonnetModel', labelKey: 'onboarding.model.slotBalanced' },
  { key: 'opusModel', labelKey: 'onboarding.model.slotPowerful' },
  { key: 'haikuModel', labelKey: 'onboarding.model.slotFast' }
]

const MODEL_DATALIST_ID = 'onboarding-model-ids'

const showKey = ref(false)
const probing = ref(false)
const probeOutcome = ref<ProbeOutcome | null>(null)
const modelIds = ref<string[]>([])

const isOAuthMethod = computed(() => OAUTH_METHODS.has(settingsStore.authMethod))

const activeConfig = computed<ProviderConfig>(() => {
  switch (settingsStore.authMethod) {
    case 'openai_compatible': return settingsStore.openaiConfig
    case 'gemini_api': return settingsStore.geminiConfig
    default: return settingsStore.anthropicConfig
  }
})

const presets = computed(() => PROVIDER_PRESETS[settingsStore.authMethod] ?? [])

const presetIndex = computed(() => {
  const index = presets.value.findIndex(p => p.baseUrl === activeConfig.value.baseUrl)
  return index === -1 ? 0 : index
})

const ready = computed(() => settingsStore.isConfigured)

const endpoint = computed(() => resolveEndpoint(settingsStore.authMethod, configsSnapshot()))

const endpointPath = computed(() => {
  if (!endpoint.value) return ''
  return `${normalizeApiUrl(endpoint.value.baseUrl, endpoint.value.target)}/models`
})

const probeMessage = computed(() => {
  const outcome = probeOutcome.value
  if (!outcome) return ''
  if (outcome.status === 'ok') return t('onboarding.model.testOk', { count: outcome.modelIds.length })
  if (outcome.reason === 'no-key') return t('onboarding.model.testNoKey')
  if (outcome.reason === 'proxy') return t('onboarding.model.testProxy')
  return t('onboarding.model.testFailed')
})

const probeOk = computed(() => probeOutcome.value?.status === 'ok')

function badgeKey(badgeType: 'recommended' | 'official'): string {
  return badgeType === 'official' ? 'auth.badgeOfficial' : 'auth.badgeRecommended'
}

function configsSnapshot() {
  return {
    anthropic: settingsStore.anthropicConfig,
    openai: settingsStore.openaiConfig,
    gemini: settingsStore.geminiConfig
  }
}

function selectMethod(next: AuthMethod) {
  if (OAUTH_METHODS.has(next) || settingsStore.authMethod === next) return
  settingsStore.authMethod = next
  probeOutcome.value = null
  modelIds.value = []
  void settingsStore.saveSettings()
}

function selectPreset(index: number) {
  const preset = presets.value[index]
  if (!preset) return
  activeConfig.value.baseUrl = preset.baseUrl
  void settingsStore.saveSettings()
}

function commitBaseUrl(event: Event) {
  activeConfig.value.baseUrl = (event.target as HTMLInputElement).value.trim()
  probeOutcome.value = null
  void settingsStore.saveSettings()
}

function commitApiKey(event: Event) {
  activeConfig.value.apiKey = (event.target as HTMLInputElement).value.trim()
  probeOutcome.value = null
  void settingsStore.saveSettings()
}

function commitSlot(key: 'haikuModel' | 'sonnetModel' | 'opusModel', value: string) {
  activeConfig.value[key] = value.trim()
  void settingsStore.saveSettings()
}

async function runTest() {
  const target = endpoint.value
  if (!target) return
  probing.value = true
  probeOutcome.value = null
  const outcome = await probeEndpoint(target)
  probeOutcome.value = outcome
  if (outcome.status === 'ok') modelIds.value = outcome.modelIds
  probing.value = false
}
</script>

<style lang="scss" scoped>
.key-block {
  margin-top: 12px;
}

.test-row {
  margin-top: 12px;
}

.state {
  margin-left: auto;
  font-size: var(--text-2xs);
  padding: 4px 9px;
  border-radius: var(--radius-full);

  &.is-ok {
    background: var(--accent-primary-glow);
    color: var(--accent-primary);
    font-weight: var(--font-weight-semibold);
  }

  &.is-pending {
    background: color-mix(in srgb, var(--warning) 16%, transparent);
    color: var(--warning);
    font-weight: var(--font-weight-semibold);
  }
}

.spin {
  animation: ob-rotate 1s linear infinite;
}

@keyframes ob-rotate {
  to { transform: rotate(360deg); }
}
</style>
