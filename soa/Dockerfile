# Image for the SOME/IP side: comfort vECU and SOME/IP provider (each runs its own someipy daemon).
FROM python:3.12-slim
WORKDIR /soa
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py run_with_daemon.sh ./
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["./run_with_daemon.sh"]
CMD ["comfort_ecu.py"]
