"""The training-worker Job in namespace ai-training (ServiceAccount limited to Jobs/Pods/logs there)."""
from __future__ import annotations

import os
import re


def job_name(run: dict) -> str:
    base = re.sub(r"[^a-z0-9-]", "-", run["_id"].lower())
    return f"train-{base}-a{int(run.get('attempt') or 1)}"[:63].rstrip("-")


WAIT_FOR_API = (
    "import os, time, urllib.request\n"
    "url = os.environ['TRAINING_API_URL'].rstrip('/') + '/health/live'\n"
    "for i in range(90):\n"
    "    try:\n"
    "        urllib.request.urlopen(url, timeout=3); print('training-api reachable after', i * 2, 's'); break\n"
    "    except Exception:\n"
    "        time.sleep(2)\n"
    "else:\n"
    "    raise SystemExit('training-api unreachable for 180 s')\n"
)


def job_manifest(run: dict, token: str, *, image: str, namespace: str, api_url: str) -> dict:
    name = job_name(run)
    env = [
        {"name": "RUN_ID", "value": run["_id"]},
        {"name": "RUN_TOKEN", "value": token},
        {"name": "TRAINING_API_URL", "value": api_url},
        {"name": "MINIO_ENDPOINT", "value": os.getenv("MINIO_ENDPOINT", "http://minio.minio.svc.cluster.local:9000")},
        {"name": "MINIO_BUCKET", "value": os.getenv("MINIO_BUCKET", "training")},
        {"name": "MINIO_ACCESS_KEY", "valueFrom": {"secretKeyRef": {"name": "training-worker-secrets", "key": "minio-access-key"}}},
        {"name": "MINIO_SECRET_KEY", "valueFrom": {"secretKeyRef": {"name": "training-worker-secrets", "key": "minio-secret-key"}}},
        {"name": "HF_TOKEN", "valueFrom": {"secretKeyRef": {"name": "training-worker-secrets", "key": "hf-token", "optional": True}}},
        {"name": "HF_HOME", "value": "/models/hf"},
        {"name": "HF_HUB_ENABLE_HF_TRANSFER", "value": "1"},
        {"name": "RUNS_DIR", "value": "/models/runs"},
        # Bulky exports (GGUF, merged weights) go to the NAS share; /models is scratch.
        {"name": "NAS_RUNS_DIR", "value": os.getenv("TRAINING_NAS_RUNS_DIR", "/nas/training/runs")},
        {"name": "BANDITBENCH_REPO", "value": os.getenv("BANDITBENCH_REPO", "")},
        {"name": "BANDITBENCH_TOKEN", "valueFrom": {"secretKeyRef": {"name": "training-worker-secrets", "key": "github-token", "optional": True}}},
    ]
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": name, "namespace": namespace,
                     "labels": {"app.kubernetes.io/name": "training-worker", "burtson.ai/run": run["_id"].lower()[:63],
                                "burtson.ai/gpu": "training"}},
        "spec": {
            # A pod lost to a node reboot or OOM retries; the worker resumes from its last checkpoint.
            "backoffLimit": 2,
            "activeDeadlineSeconds": int(os.getenv("TRAINING_MAX_SECONDS", str(3 * 24 * 3600))),
            "ttlSecondsAfterFinished": 7 * 24 * 3600,
            "template": {
                "metadata": {"labels": {"app.kubernetes.io/name": "training-worker", "burtson.ai/gpu": "training",
                                        "burtson.ai/run": run["_id"].lower()[:63]}},
                "spec": {
                    "restartPolicy": "Never",
                    "serviceAccountName": "training-worker",
                    "automountServiceAccountToken": False,
                    "imagePullSecrets": [{"name": "ghcr-secret"}],
                    "nodeSelector": {"kubernetes.io/hostname": os.getenv("TRAINING_NODE", "son-of-anton")},
                    "tolerations": [{"key": "dedicated", "operator": "Equal", "value": "ai", "effect": "NoSchedule"}],
                    "terminationGracePeriodSeconds": 120,
                    # k3s applies the training-api NetworkPolicy to a new pod's IP a few seconds after it
                    # starts; until then connections are refused. Wait for training-api before the worker
                    # runs (same image, so nothing extra to pull).
                    "initContainers": [{
                        "name": "wait-for-api", "image": image, "imagePullPolicy": "IfNotPresent",
                        "command": ["python3", "-c", WAIT_FOR_API],
                        "env": [{"name": "TRAINING_API_URL", "value": api_url}],
                        "resources": {"requests": {"cpu": "50m", "memory": "64Mi"}},
                    }],
                    "containers": [{
                        "name": "worker", "image": image, "imagePullPolicy": "IfNotPresent",
                        "args": ["--run", run["_id"]] + (["--smoke"] if run.get("smoke") else []),
                        "env": env,
                        "resources": {
                            "requests": {"cpu": "4", "memory": "24Gi", "nvidia.com/gpu": "1"},
                            "limits": {"memory": os.getenv("TRAINING_MEMORY_LIMIT", "96Gi"), "nvidia.com/gpu": "1"},
                        },
                        "volumeMounts": [{"name": "models", "mountPath": "/models"},
                                         {"name": "nas", "mountPath": "/nas/training"},
                                         {"name": "shm", "mountPath": "/dev/shm"}],
                    }],
                    "volumes": [{"name": "models", "persistentVolumeClaim": {"claimName": "training-models"}},
                                {"name": "nas", "persistentVolumeClaim": {"claimName": os.getenv("TRAINING_NAS_CLAIM", "training-nas")}},
                                {"name": "shm", "emptyDir": {"medium": "Memory", "sizeLimit": "16Gi"}}],
                },
            },
        },
    }


class K8sLauncher:
    def __init__(self):
        from kubernetes import client, config

        try:
            config.load_incluster_config()
        except Exception:
            config.load_kube_config()
        self.batch = client.BatchV1Api()
        self.core = client.CoreV1Api()
        self.namespace = os.getenv("TRAINING_NAMESPACE", "ai-training")
        self.image = os.getenv("TRAINING_WORKER_IMAGE", "ghcr.io/burtson-labs/training-worker:latest")
        self.api_url = os.getenv("TRAINING_API_INTERNAL_URL", "http://training-api.ai-training.svc.cluster.local:8080")

    def launch(self, run, token):
        manifest = job_manifest(run, token, image=self.image, namespace=self.namespace, api_url=self.api_url)
        self.batch.create_namespaced_job(self.namespace, manifest)
        return manifest["metadata"]["name"]

    def delete(self, job_name):
        from kubernetes.client import V1DeleteOptions
        from kubernetes.client.exceptions import ApiException

        try:
            self.batch.delete_namespaced_job(job_name, self.namespace,
                                             body=V1DeleteOptions(propagation_policy="Foreground", grace_period_seconds=120))
        except ApiException as exc:
            if exc.status != 404:
                raise

    def state(self, job_name):
        from kubernetes.client.exceptions import ApiException

        try:
            job = self.batch.read_namespaced_job_status(job_name, self.namespace)
        except ApiException as exc:
            if exc.status == 404:
                return "missing"
            raise
        for cond in job.status.conditions or []:
            if cond.status == "True" and cond.type == "Complete":
                return "succeeded"
            if cond.status == "True" and cond.type == "Failed":
                return "failed"
        return "active"

    def logs(self, job_name, lines):
        pods = self.core.list_namespaced_pod(self.namespace, label_selector=f"job-name={job_name}").items
        if not pods:
            return []
        pod = sorted(pods, key=lambda p: p.metadata.creation_timestamp)[-1]
        text = self.core.read_namespaced_pod_log(pod.metadata.name, self.namespace, tail_lines=lines)
        return text.splitlines()[-lines:]
