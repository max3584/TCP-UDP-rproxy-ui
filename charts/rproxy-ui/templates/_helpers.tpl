{{- define "rproxy-ui.fullname" -}}
{{- if contains "rproxy-ui" .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-rproxy-ui" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "rproxy-ui.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: rproxy-ui
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{/* pods of this release's UI, migration and backup (rproxy-gateway's ui.podSelector default is name rproxy-ui and component ui: the UI pods only) */}}
{{- define "rproxy-ui.selectorLabels" -}}
app.kubernetes.io/name: rproxy-ui
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "rproxy-ui.mariadbName" -}}
{{- printf "%s-mariadb" (include "rproxy-ui.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rproxy-ui.mariadbSelectorLabels" -}}
app.kubernetes.io/name: mariadb
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: database
{{- end -}}

{{- define "rproxy-ui.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "rproxy-ui.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "rproxy-ui.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "rproxy-ui.dbHost" -}}
{{- if .Values.db.host -}}
{{- .Values.db.host -}}
{{- else if .Values.mariadb.enabled -}}
{{- include "rproxy-ui.mariadbName" . -}}
{{- else -}}
{{- fail "db.host is required (or mariadb.enabled=true for the bundled MariaDB)" -}}
{{- end -}}
{{- end -}}

{{- define "rproxy-ui.existingSecret" -}}
{{- required "existingSecret is required: a Secret with NEXTAUTH_SECRET, KEYCLOAK_CLIENT_SECRET and DB_PASSWORD" .Values.existingSecret -}}
{{- end -}}

{{/* DB_* for the UI and the migration Job (the password from existingSecret) */}}
{{- define "rproxy-ui.dbEnv" -}}
- name: DB_HOST
  value: {{ include "rproxy-ui.dbHost" . | quote }}
- name: DB_PORT
  value: {{ .Values.db.port | quote }}
- name: DB_DATABASE
  value: {{ .Values.db.database | quote }}
- name: DB_USER
  value: {{ .Values.db.user | quote }}
- name: DB_PASSWORD
  valueFrom: {secretKeyRef: {name: {{ include "rproxy-ui.existingSecret" . }}, key: DB_PASSWORD}}
{{- end -}}

{{- define "rproxy-ui.podSecurityContext" -}}
{{- toYaml .Values.podSecurityContext -}}
{{- end -}}
