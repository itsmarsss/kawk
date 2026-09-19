"""One finite windowed SAM3.1 check; importing does not submit a job."""
from truss.base.truss_config import AcceleratorSpec
from truss_train import (
    CacheConfig,
    CheckpointingConfig,
    Compute,
    Image,
    Runtime,
    TrainingJob,
    TrainingProject,
)

training_project = TrainingProject(
    name="htn2-sam31-windowed-rnd",
    job=TrainingJob(
        image=Image(base_image="pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime"),
        compute=Compute(cpu_count=8, memory="64Gi",
                        accelerator=AcceleratorSpec(accelerator="H100", count=1)),
        runtime=Runtime(
            start_commands=["timeout --signal=TERM --kill-after=10s 1380s python -u bootstrap.py"],
            environment_variables={"TOKENIZERS_PARALLELISM": "false"},
            cache_config=CacheConfig(enabled=True),
            checkpointing_config=CheckpointingConfig(enabled=True, volume_size_gib=16),
        ),
    ),
)
