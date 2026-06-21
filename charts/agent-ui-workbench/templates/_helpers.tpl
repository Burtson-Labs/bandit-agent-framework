{{/*
Return the fully qualified name of a resource.
*/}}
{{- define "stealth.fullname" -}}
{{- if .Values.fullnameOverride }}
  {{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else }}
  {{- $name := include "stealth.name" . -}}
  {{- if ne $name .Release.Name -}}
    {{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
  {{- else -}}
    {{- printf "%s" $name | trunc 63 | trimSuffix "-" -}}
  {{- end -}}
{{- end -}}
{{- end -}}

{{/*
Return the name of a resource.
*/}}
{{- define "stealth.name" -}}
{{- if .Values.nameOverride }}
  {{- .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- else }}
  {{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Return the chart name with the version.
*/}}
{{- define "stealth.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version -}}
{{- end -}}

{{/*
Common labels
*/}}
{{- define "stealth.labels" -}}
app.kubernetes.io/name: {{ include "stealth.name" . }}
helm.sh/chart: {{ include "stealth.chart" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
